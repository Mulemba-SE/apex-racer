import * as THREE from 'three'
import type { Updatable } from '@/core/Game'
import type { Controls } from '@/core/Input'

export interface CarConfig {
  maxSpeed: number // m/s, forward (55 is about 200 km/h)
  maxReverseSpeed: number // m/s
  acceleration: number // m/s²
  brakeDecel: number // m/s²
  coastDecel: number // m/s², engine drag when no pedal is pressed
  handbrakeDecel: number // m/s²
  turnRate: number // rad/s at full lock and full authority
  steerResponse: number // how fast steering builds toward the input (units/s)
  steerReturn: number // how fast steering returns to centre (units/s)
  grip: number // 1/s, how quickly sideways slip is removed
  handbrakeGrip: number // 1/s, same, with the handbrake held
}

export const DEFAULT_CAR_CONFIG: CarConfig = {
  maxSpeed: 55,
  maxReverseSpeed: 12,
  acceleration: 24,
  brakeDecel: 45,
  coastDecel: 6,
  handbrakeDecel: 10,
  turnRate: 2.0,
  steerResponse: 5,
  steerReturn: 8,
  grip: 12,
  handbrakeGrip: 1.5,
}

/** Half the car's footprint in metres. Collision tests the corners of this box. */
export const CAR_HALF_WIDTH = 0.95
export const CAR_HALF_LENGTH = 2.1

/** How the ground under the car changes its handling. 1 = same as asphalt. */
export interface SurfaceModifiers {
  grip: number // multiplies sideways grip; lower means more sliding
  traction: number // multiplies acceleration
  drag: number // 1/s, how quickly forward speed bleeds off (0 = none)
}

export const ASPHALT: SurfaceModifiers = { grip: 1, traction: 1, drag: 0 }
export const KERB: SurfaceModifiers = { grip: 0.85, traction: 0.9, drag: 0.05 }
export const GRASS: SurfaceModifiers = { grip: 0.4, traction: 0.5, drag: 0.5 }

const WHEEL_RADIUS = 0.35
const MAX_WHEEL_LOCK = 0.45 // radians, visual only
const MAX_YAW_KICK = 4 // rad/s
const YAW_KICK_DECAY = 5 // 1/s

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function moveToward(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) return target
  return current + Math.sign(target - current) * maxDelta
}

export class Car implements Updatable {
  /** Add this to the scene. Its transform is the car's visual transform. */
  readonly object = new THREE.Group()
  readonly config: CarConfig

  // Simulation state. The car faces -Z when heading = 0 (Three.js convention),
  // and a positive heading turns it left (counter-clockwise from above).
  readonly position = new THREE.Vector3()
  readonly velocity = new THREE.Vector3() // world space, m/s, y unused
  heading = 0

  /** Set every step by the collision system. */
  surface: SurfaceModifiers = ASPHALT

  private readonly controls: Controls
  private readonly body = new THREE.Group() // rolls in corners; wheels don't
  private readonly wheels: THREE.Mesh[] = []
  private readonly frontPivots: THREE.Group[] = []

  private readonly forward = new THREE.Vector3()
  private readonly right = new THREE.Vector3()
  private steerValue = 0 // smoothed steering, -1..1
  private roll = 0
  private yawKick = 0 // rad/s of extra spin from impacts; decays on its own

  // Previous step, kept for render interpolation.
  private readonly prevPosition = new THREE.Vector3()
  private prevHeading = 0

  constructor(controls: Controls, config: Partial<CarConfig> = {}) {
    this.controls = controls
    this.config = { ...DEFAULT_CAR_CONFIG, ...config }
    this.buildModel()
    this.interpolate(1)
  }

  /** Current speed in km/h, for the HUD later. */
  get speedKmh(): number {
    return this.velocity.length() * 3.6
  }

  update(dt: number): void {
    const c = this.controls
    const cfg = this.config
    const surface = this.surface

    this.prevPosition.copy(this.position)
    this.prevHeading = this.heading

    // Split world velocity into forward and sideways parts.
    this.updateAxes()
    let vf = this.velocity.dot(this.forward)
    let vl = this.velocity.dot(this.right)

    // Forward speed: throttle, brake, reverse, coast.
    const drive = c.throttle - c.brake
    if (c.throttle > 0 && c.brake > 0) {
      vf = moveToward(vf, 0, cfg.brakeDecel * dt) // both pedals: just stop
    } else if (drive > 0) {
      if (vf < -0.5) {
        vf += cfg.brakeDecel * dt // throttle while rolling backwards = brake
      } else {
        const headroom = 1 - Math.max(vf, 0) / cfg.maxSpeed // eases into top speed
        vf += cfg.acceleration * surface.traction * drive * headroom * dt
      }
    } else if (drive < 0) {
      if (vf > 0.5) {
        vf = Math.max(vf + cfg.brakeDecel * drive * dt, 0)
      } else {
        vf = Math.max(
          vf + cfg.acceleration * 0.6 * surface.traction * drive * dt,
          -cfg.maxReverseSpeed,
        )
      }
    } else {
      vf = moveToward(vf, 0, cfg.coastDecel * dt)
    }
    if (c.handbrake) vf = moveToward(vf, 0, cfg.handbrakeDecel * dt)

    // Surface drag: grass bleeds off speed in proportion to how fast you are going.
    if (surface.drag > 0) vf *= Math.exp(-surface.drag * dt)

    // Sideways slip decays; less grip with the handbrake means a longer slide.
    const grip = (c.handbrake ? cfg.handbrakeGrip : cfg.grip) * surface.grip
    vl *= Math.exp(-grip * dt)

    // Smooth the steering input.
    const building =
      c.steer !== 0 && Math.sign(c.steer) === Math.sign(this.steerValue || c.steer)
    const steerRate = building ? cfg.steerResponse : cfg.steerReturn
    this.steerValue = moveToward(this.steerValue, c.steer, steerRate * dt)

    // Steering authority depends on speed: none when stopped, softer when fast.
    const speed = Math.abs(vf)
    const lowSpeed = clamp(speed / 5, 0, 1)
    const highSpeed = 1 - 0.5 * clamp(speed / cfg.maxSpeed, 0, 1)
    const authority = lowSpeed * highSpeed * (c.handbrake ? 1.3 : 1)
    const yawRate = this.steerValue * cfg.turnRate * authority * (vf >= 0 ? 1 : -1)

    // Recombine with the OLD axes, then turn. The velocity keeps its old
    // direction for a moment, which is where the slip (and the drift) comes from.
    this.velocity
      .copy(this.forward)
      .multiplyScalar(vf)
      .addScaledVector(this.right, vl)
    this.heading -= yawRate * dt // steering right (positive) lowers heading
    this.heading += this.yawKick * dt // impact spin; positive turns the car left
    this.yawKick *= Math.exp(-YAW_KICK_DECAY * dt)
    this.position.addScaledVector(this.velocity, dt)

    this.animate(dt, vf)
    this.interpolate(1)
  }

  /**
   * Adds a short burst of spin from an impact, in rad/s. Positive turns the car
   * left. It fades out by itself, so callers don't need to undo it.
   */
  kick(yawRate: number): void {
    this.yawKick = clamp(this.yawKick + yawRate, -MAX_YAW_KICK, MAX_YAW_KICK)
  }

  /**
   * Places the visual transform between the previous and current step.
   * alpha = 1 means "exactly the current step". It is called from the render
   * hook so motion stays smooth on 120/144 Hz displays.
   */
  interpolate(alpha: number): void {
    this.object.position.lerpVectors(this.prevPosition, this.position, alpha)
    this.object.rotation.y = THREE.MathUtils.lerp(this.prevHeading, this.heading, alpha)
  }

  reset(x: number, z: number, heading: number): void {
    this.position.set(x, 0, z)
    this.velocity.set(0, 0, 0)
    this.heading = heading
    this.steerValue = 0
    this.roll = 0
    this.yawKick = 0
    this.surface = ASPHALT
    this.prevPosition.copy(this.position)
    this.prevHeading = heading
    this.interpolate(1)
  }

  private updateAxes(): void {
    const s = Math.sin(this.heading)
    const c = Math.cos(this.heading)
    this.forward.set(-s, 0, -c)
    this.right.set(c, 0, -s)
  }

  /** Visual-only motion: wheel spin, front-wheel steering, body roll. */
  private animate(dt: number, forwardSpeed: number): void {
    const spin = (forwardSpeed * dt) / WHEEL_RADIUS
    for (const wheel of this.wheels) wheel.rotation.x -= spin
    for (const pivot of this.frontPivots) {
      pivot.rotation.y = -this.steerValue * MAX_WHEEL_LOCK
    }

    const speedFraction = clamp(Math.abs(forwardSpeed) / this.config.maxSpeed, 0, 1)
    const targetRoll = this.steerValue * speedFraction * 0.06 // leans outward
    this.roll += (targetRoll - this.roll) * Math.min(1, 8 * dt)
    this.body.rotation.z = this.roll
  }

  private buildModel(): void {
    const paint = new THREE.MeshStandardMaterial({ color: 0xd62828, roughness: 0.45, metalness: 0.3 })
    const glass = new THREE.MeshStandardMaterial({ color: 0x1b2a3a, roughness: 0.2, metalness: 0.6 })
    const tyre = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 })
    const rim = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.4, metalness: 0.8 })
    const lamp = new THREE.MeshStandardMaterial({
      color: 0xfff2b0,
      emissive: 0xfff2b0,
      emissiveIntensity: 1.5,
    })

    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 4.2), paint)
    chassis.position.y = 0.58

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 2.0), glass)
    cabin.position.set(0, 1.1, 0.3)

    // Headlights mark the front (-Z) so you can tell which way the car faces.
    const lampGeo = new THREE.BoxGeometry(0.4, 0.15, 0.05)
    for (const x of [-0.65, 0.65]) {
      const l = new THREE.Mesh(lampGeo, lamp)
      l.position.set(x, 0.65, -2.1)
      this.body.add(l)
    }

    this.body.add(chassis, cabin)
    this.object.add(this.body)

    // The cylinder's axis is rotated onto X so the wheel spins about X.
    const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.3, 20)
    wheelGeo.rotateZ(Math.PI / 2)
    // A bar across each wheel, so you can see it spinning.
    const hubGeo = new THREE.BoxGeometry(0.34, 0.1, 0.5)

    const layout = [
      { x: -1.0, z: -1.3, front: true },
      { x: 1.0, z: -1.3, front: true },
      { x: -1.0, z: 1.3, front: false },
      { x: 1.0, z: 1.3, front: false },
    ]
    for (const w of layout) {
      const pivot = new THREE.Group() // steers (front) or just positions (rear)
      pivot.position.set(w.x, WHEEL_RADIUS, w.z)
      const wheel = new THREE.Mesh(wheelGeo, tyre)
      wheel.add(new THREE.Mesh(hubGeo, rim))
      pivot.add(wheel)
      this.object.add(pivot)
      this.wheels.push(wheel)
      if (w.front) this.frontPivots.push(pivot)
    }

    this.object.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true
    })
  }
}