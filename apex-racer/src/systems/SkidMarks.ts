import * as THREE from 'three'
import type { Car } from '@/entities/Car'

// Wheel positions in the car's local space. These match the layout in Car.buildModel().
const WHEELS = [
  { x: -1.0, z: -1.3, weight: 0.7 }, // front wheels mark a little lighter
  { x: 1.0, z: -1.3, weight: 0.7 },
  { x: -1.0, z: 1.3, weight: 1 },
  { x: 1.0, z: 1.3, weight: 1 },
] as const

const HALF_WIDTH = 0.16 // metres; half the width of a mark
const HEIGHT = 0.04 // metres above the ground, clear of the kerbs
const MIN_STEP = 0.5 // metres a wheel must travel before the next quad is added
const MAX_GAP = 8 // metres; a bigger jump means a teleport (a restart, say), so the trail is cut
const SLIP_START = 3.5 // m/s of sideways speed where marks begin
const SLIP_FULL = 8.5 // m/s where marks are at full strength
const MIN_INTENSITY = 0.05
const MAX_ALPHA = 0.6
const GRASS_DRAG = 0.15 // the car's surface drag above this means it is mostly on grass: no marks

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** The state of one wheel's current line of marks. */
interface Trail {
  active: boolean // has a previous point
  hasEdges: boolean // the previous point's left and right edges are known
  x: number
  z: number
  lx: number
  lz: number
  rx: number
  rz: number
  alpha: number
}

function makeTrail(): Trail {
  return { active: false, hasEdges: false, x: 0, z: 0, lx: 0, lz: 0, rx: 0, rz: 0, alpha: 0 }
}

export class SkidMarks {
  /** Add this to the scene. */
  readonly object: THREE.Mesh

  private readonly cars: readonly Car[]
  private readonly trails: Trail[][] // one list of four per car
  private readonly maxQuads: number
  private readonly positions: Float32Array
  private readonly colors: Float32Array
  private readonly positionAttr: THREE.BufferAttribute
  private readonly colorAttr: THREE.BufferAttribute
  private readonly geometry: THREE.BufferGeometry
  private readonly material: THREE.MeshBasicMaterial
  private head = 0 // the next slot to write
  private count = 0 // how many slots hold a valid quad
  private dirty = false

  constructor(cars: readonly Car[], maxQuads = 6000) {
    this.cars = cars
    this.maxQuads = maxQuads
    this.trails = cars.map(() => WHEELS.map(makeTrail))

    // Each quad owns four vertices, so overwriting an old quad never disturbs its neighbours.
    this.positions = new Float32Array(maxQuads * 4 * 3)
    this.colors = new Float32Array(maxQuads * 4 * 4) // red, green, blue and alpha per vertex
    for (let q = 0; q < maxQuads; q++) {
      for (let v = 0; v < 4; v++) {
        const o = (q * 4 + v) * 4
        this.colors[o] = 0.04
        this.colors[o + 1] = 0.04
        this.colors[o + 2] = 0.045
      }
    }

    const indices = new Uint32Array(maxQuads * 6)
    for (let q = 0; q < maxQuads; q++) {
      const v = q * 4
      const i = q * 6
      indices[i] = v // two triangles, wound so they face up
      indices[i + 1] = v + 2
      indices[i + 2] = v + 1
      indices[i + 3] = v + 1
      indices[i + 4] = v + 2
      indices[i + 5] = v + 3
    }

    this.positionAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage)
    this.colorAttr = new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage)
    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', this.positionAttr)
    this.geometry.setAttribute('color', this.colorAttr)
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    this.geometry.setDrawRange(0, 0)

    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true, // a four-component colour attribute also gives per-vertex transparency
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true, // pulls the marks toward the camera, so they never flicker against the road
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    })

    this.object = new THREE.Mesh(this.geometry, this.material)
    this.object.frustumCulled = false // the buffer starts empty, so its bounds would be wrong
    this.object.renderOrder = 1
  }

  /**
   * Call once per display frame, after every car has been interpolated, because
   * the marks follow the cars' visual positions and not their physics positions.
   */
  update(): void {
    this.cars.forEach((car, ci) => {
      const trails = this.trails[ci]!
      const obj = car.object
      const sin = Math.sin(obj.rotation.y)
      const cos = Math.cos(obj.rotation.y)

      // Sideways speed in m/s: the part of the velocity along the car's right-hand axis.
      const h = car.heading
      const slip = Math.abs(car.velocity.x * Math.cos(h) - car.velocity.z * Math.sin(h))
      const speed = car.velocity.length()
      const onRoad = car.surface.drag < GRASS_DRAG
      const base = onRoad
        ? clamp((slip - SLIP_START) / (SLIP_FULL - SLIP_START), 0, 1) * clamp(speed / 5, 0, 1)
        : 0

      WHEELS.forEach((wheel, wi) => {
        const trail = trails[wi]!
        const intensity = base * wheel.weight
        if (intensity < MIN_INTENSITY) {
          trail.active = false // the line of marks ends here
          return
        }
        // The wheel's world position: the same rotation Three.js applies to the car.
        const wx = obj.position.x + wheel.x * cos + wheel.z * sin
        const wz = obj.position.z - wheel.x * sin + wheel.z * cos
        this.extend(trail, wx, wz, intensity * MAX_ALPHA)
      })
    })

    if (this.dirty) {
      this.positionAttr.needsUpdate = true
      this.colorAttr.needsUpdate = true
      this.geometry.setDrawRange(0, this.count * 6)
      this.dirty = false
    }
  }

  /** Removes every mark. Call it when the cars are put back on the grid. */
  clear(): void {
    this.head = 0
    this.count = 0
    this.dirty = false
    this.geometry.setDrawRange(0, 0)
    for (const list of this.trails) for (const t of list) t.active = false
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.object.removeFromParent()
  }

  private extend(t: Trail, wx: number, wz: number, alpha: number): void {
    if (!t.active) {
      t.active = true
      t.hasEdges = false
      t.x = wx
      t.z = wz
      t.alpha = alpha
      return
    }

    const dx = wx - t.x
    const dz = wz - t.z
    const dist2 = dx * dx + dz * dz
    if (dist2 < MIN_STEP * MIN_STEP) return // hasn't moved far enough yet
    if (dist2 > MAX_GAP * MAX_GAP) {
      // A jump, not a drive: start a new line from here.
      t.x = wx
      t.z = wz
      t.alpha = alpha
      t.hasEdges = false
      return
    }

    // The mark's width runs perpendicular to the direction the wheel travelled.
    const k = HALF_WIDTH / Math.sqrt(dist2)
    const nx = -dz * k
    const nz = dx * k
    const curLx = wx + nx
    const curLz = wz + nz
    const curRx = wx - nx
    const curRz = wz - nz

    if (!t.hasEdges) {
      // The first segment of a line: the previous point's edges use this direction too.
      t.lx = t.x + nx
      t.lz = t.z + nz
      t.rx = t.x - nx
      t.rz = t.z - nz
      t.hasEdges = true
    }

    this.pushQuad(t.lx, t.lz, t.rx, t.rz, t.alpha, curLx, curLz, curRx, curRz, alpha)

    t.x = wx
    t.z = wz
    t.lx = curLx
    t.lz = curLz
    t.rx = curRx
    t.rz = curRz
    t.alpha = alpha
  }

  private pushQuad(
    pLx: number,
    pLz: number,
    pRx: number,
    pRz: number,
    pAlpha: number,
    cLx: number,
    cLz: number,
    cRx: number,
    cRz: number,
    cAlpha: number,
  ): void {
    const q = this.head
    const p = q * 12
    const c = q * 16
    const pos = this.positions
    const col = this.colors

    pos[p] = pLx
    pos[p + 1] = HEIGHT
    pos[p + 2] = pLz
    pos[p + 3] = pRx
    pos[p + 4] = HEIGHT
    pos[p + 5] = pRz
    pos[p + 6] = cLx
    pos[p + 7] = HEIGHT
    pos[p + 8] = cLz
    pos[p + 9] = cRx
    pos[p + 10] = HEIGHT
    pos[p + 11] = cRz

    col[c + 3] = pAlpha // the alpha of each of the four vertices
    col[c + 7] = pAlpha
    col[c + 11] = cAlpha
    col[c + 15] = cAlpha

    this.head = (q + 1) % this.maxQuads
    this.count = Math.min(this.count + 1, this.maxQuads)
    this.dirty = true
  }
}