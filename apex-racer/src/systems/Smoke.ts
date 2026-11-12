import * as THREE from 'three'
import type { Car } from '@/entities/Car'

// Rear wheel positions in the car's local space. These match the layout in Car.buildModel().
const REAR_WHEELS = [
  { x: -1.0, z: 1.3 },
  { x: 1.0, z: 1.3 },
] as const

const GRASS_DRAG = 0.15 // the car's surface drag above this means it is mostly on grass
const SLIP_START = 3.5 // m/s of sideways speed where smoke begins (same as the skid marks)
const SLIP_FULL = 9 // m/s where smoke is at full strength
const SMOKE_RATE = 70 // particles per second per wheel, at full strength
const DUST_RATE = 45
const MIN_STRENGTH = 0.02 // below this a wheel emits nothing
const MAX_DT = 0.05 // seconds; a longer frame (a stall, say) is treated as this long

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

const VERTEX_SHADER = /* glsl */ `
  attribute float aSize;
  attribute vec4 aColor;
  uniform float uScale;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // aSize is a diameter in metres. uScale turns it into pixels at a depth of 1 metre.
    gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.001), 0.0, 256.0);
    gl_Position = projectionMatrix * mv;
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  varying vec4 vColor;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
    float soft = 1.0 - smoothstep(0.35, 1.0, d); // a soft round puff, not a square
    if (soft <= 0.001) discard;
    gl_FragColor = vec4(vColor.rgb, vColor.a * soft);
  }
`

export class Smoke {
  /** Add this to the scene. */
  readonly object: THREE.Points

  private readonly cars: readonly Car[]
  private readonly max: number

  // Geometry data, uploaded to the GPU every frame.
  private readonly positions: Float32Array
  private readonly sizes: Float32Array
  private readonly colors: Float32Array // red, green, blue and alpha per particle
  private readonly positionAttr: THREE.BufferAttribute
  private readonly sizeAttr: THREE.BufferAttribute
  private readonly colorAttr: THREE.BufferAttribute

  // Simulation data, which stays on the CPU.
  private readonly velocity: Float32Array
  private readonly age: Float32Array
  private readonly life: Float32Array
  private readonly size0: Float32Array // diameter when born
  private readonly size1: Float32Array // diameter when it dies
  private readonly alpha0: Float32Array // peak opacity
  private readonly accumulator: Float32Array // fractional particles owed, per car x rear wheel x (smoke, dust)

  private readonly geometry: THREE.BufferGeometry
  private readonly material: THREE.ShaderMaterial
  private readonly scale = { value: 1 }
  private head = 0 // the next slot to write

  constructor(cars: readonly Car[], maxParticles = 600) {
    this.cars = cars
    this.max = maxParticles

    this.positions = new Float32Array(maxParticles * 3)
    this.sizes = new Float32Array(maxParticles)
    this.colors = new Float32Array(maxParticles * 4)
    this.velocity = new Float32Array(maxParticles * 3)
    this.age = new Float32Array(maxParticles).fill(1)
    this.life = new Float32Array(maxParticles).fill(1) // age = life means dead
    this.size0 = new Float32Array(maxParticles)
    this.size1 = new Float32Array(maxParticles)
    this.alpha0 = new Float32Array(maxParticles)
    this.accumulator = new Float32Array(cars.length * REAR_WHEELS.length * 2)

    this.positionAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage)
    this.sizeAttr = new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage)
    this.colorAttr = new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage)
    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', this.positionAttr)
    this.geometry.setAttribute('aSize', this.sizeAttr)
    this.geometry.setAttribute('aColor', this.colorAttr)

    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: this.scale },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false, // puffs don't hide each other; the car and barriers still hide puffs behind them
    })

    this.object = new THREE.Points(this.geometry, this.material)
    this.object.frustumCulled = false // the points move, so the bounds of the first frame would be wrong
    this.object.renderOrder = 2 // after the road and the tyre marks
  }

  /**
   * Call once per display frame, after every car has been interpolated and the camera has moved.
   * `bufferHeight` is the renderer's drawing-buffer height in pixels (renderer.domElement.height).
   */
  update(frameDt: number, camera: THREE.PerspectiveCamera, bufferHeight: number): void {
    const dt = Math.min(frameDt, MAX_DT)
    this.scale.value = bufferHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
    this.emit(dt)
    this.advance(dt)
    this.positionAttr.needsUpdate = true
    this.sizeAttr.needsUpdate = true
    this.colorAttr.needsUpdate = true
  }

  /** Removes every particle. Call it when the cars are put back on the grid. */
  clear(): void {
    this.age.fill(1)
    this.life.fill(1)
    this.sizes.fill(0)
    this.colors.fill(0)
    this.accumulator.fill(0)
    this.head = 0
    this.sizeAttr.needsUpdate = true
    this.colorAttr.needsUpdate = true
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.object.removeFromParent()
  }

  private emit(dt: number): void {
    this.cars.forEach((car, ci) => {
      const obj = car.object
      const sin = Math.sin(obj.rotation.y)
      const cos = Math.cos(obj.rotation.y)

      // Sideways speed in m/s: the part of the velocity along the car's right-hand axis.
      const h = car.heading
      const slip = Math.abs(car.velocity.x * Math.cos(h) - car.velocity.z * Math.sin(h))
      const speed = car.velocity.length()
      const onGrass = car.surface.drag >= GRASS_DRAG

      const smokeStrength = onGrass
        ? 0
        : clamp((slip - SLIP_START) / (SLIP_FULL - SLIP_START), 0, 1) * clamp(speed / 5, 0, 1)
      const dustStrength = onGrass ? clamp(speed / 25, 0, 1) : 0

      REAR_WHEELS.forEach((wheel, wi) => {
        const k = (ci * REAR_WHEELS.length + wi) * 2

        // The wheel's world position: the same rotation Three.js applies to the car.
        const wx = obj.position.x + wheel.x * cos + wheel.z * sin
        const wz = obj.position.z - wheel.x * sin + wheel.z * cos

        this.accumulator[k] = this.owed(this.accumulator[k]!, SMOKE_RATE, smokeStrength, dt)
        while (this.accumulator[k]! >= 1) {
          this.accumulator[k]! -= 1
          this.spawn(wx, wz, car, false, smokeStrength, Math.random() * dt)
        }

        this.accumulator[k + 1] = this.owed(this.accumulator[k + 1]!, DUST_RATE, dustStrength, dt)
        while (this.accumulator[k + 1]! >= 1) {
          this.accumulator[k + 1]! -= 1
          this.spawn(wx, wz, car, true, dustStrength, Math.random() * dt)
        }
      })
    })
  }

  /** How many particles are owed after this frame, or zero when the effect is off. */
  private owed(current: number, rate: number, strength: number, dt: number): number {
    return strength < MIN_STRENGTH ? 0 : current + rate * strength * dt
  }

  /**
   * `back` is a random part of this frame, in seconds. The particle is placed that far back along
   * the car's path, so a fast car leaves a continuous trail instead of one clump per frame.
   */
  private spawn(x: number, z: number, car: Car, dust: boolean, strength: number, back: number): void {
    const i = this.head
    this.head = (i + 1) % this.max

    const spread = dust ? 1.0 : 0.6
    const p = i * 3
    this.positions[p] = x - car.velocity.x * back + (Math.random() - 0.5) * 0.4
    this.positions[p + 1] = 0.15 + Math.random() * 0.15
    this.positions[p + 2] = z - car.velocity.z * back + (Math.random() - 0.5) * 0.4

    // A little of the car's speed carries over, plus a random spread and a lift.
    this.velocity[p] = car.velocity.x * 0.12 + (Math.random() - 0.5) * 2 * spread
    this.velocity[p + 1] = (dust ? 0.5 : 0.6) + Math.random() * (dust ? 0.8 : 0.9)
    this.velocity[p + 2] = car.velocity.z * 0.12 + (Math.random() - 0.5) * 2 * spread

    this.age[i] = 0
    this.life[i] = dust ? 0.8 + Math.random() * 0.6 : 1.2 + Math.random() * 0.8
    this.size0[i] = dust ? 0.7 : 0.6
    this.size1[i] = dust ? 3.2 + Math.random() : 2.6 + Math.random() * 0.8
    this.alpha0[i] = (dust ? 0.32 : 0.38) * (0.5 + 0.5 * strength)

    const c = i * 4
    if (dust) {
      this.colors[c] = 0.52 + Math.random() * 0.06
      this.colors[c + 1] = 0.46 + Math.random() * 0.06
      this.colors[c + 2] = 0.32 + Math.random() * 0.05
    } else {
      const shade = 0.82 + Math.random() * 0.12
      this.colors[c] = shade
      this.colors[c + 1] = shade
      this.colors[c + 2] = shade + 0.02
    }
    this.colors[c + 3] = 0
    this.sizes[i] = this.size0[i]!
  }

  private advance(dt: number): void {
    const slow = Math.exp(-1.8 * dt) // air resistance, so puffs hang in the air instead of flying off
    for (let i = 0; i < this.max; i++) {
      const life = this.life[i]!
      const age = this.age[i]! + dt
      if (age >= life) {
        this.age[i] = life
        this.sizes[i] = 0 // dead: a zero-sized point isn't drawn
        continue
      }
      this.age[i] = age
      const t = age / life

      const p = i * 3
      this.velocity[p] = this.velocity[p]! * slow
      this.velocity[p + 1] = this.velocity[p + 1]! * slow
      this.velocity[p + 2] = this.velocity[p + 2]! * slow
      this.positions[p] = this.positions[p]! + this.velocity[p]! * dt
      this.positions[p + 1] = this.positions[p + 1]! + this.velocity[p + 1]! * dt
      this.positions[p + 2] = this.positions[p + 2]! + this.velocity[p + 2]! * dt

      // Grows quickly at first and then slows; fades in over the first tenth of its life, then out.
      this.sizes[i] = lerp(this.size0[i]!, this.size1[i]!, 1 - (1 - t) * (1 - t))
      this.colors[i * 4 + 3] = this.alpha0[i]! * Math.min(1, t * 10) * (1 - t)
    }
  }
}