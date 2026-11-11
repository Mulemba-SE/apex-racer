import type { Updatable } from '@/core/Game'
import type { Controls } from '@/core/Input'
import type { Car } from '@/entities/Car'
import type { TrackData } from '@/entities/TrackData'

export interface AIOptions {
  topSpeedFraction: number // share of the car's top speed this driver will use
  cornerAccel: number // m/s², the sideways acceleration the driver accepts in corners
  laneOffset: number // metres from the centre line; positive is right of travel
  lookAheadBase: number // metres
  lookAheadTime: number // seconds of travel added to the look-ahead distance
  steerGain: number // 1 = steer exactly what the pursuit geometry asks for
}

export const DEFAULT_AI_OPTIONS: AIOptions = {
  topSpeedFraction: 0.92,
  cornerAccel: 22,
  laneOffset: 0,
  lookAheadBase: 9,
  lookAheadTime: 0.3,
  steerGain: 1,
}

const BRAKE_PLAN = 0.6 // plan braking with this share of the car's real brake power
const SMOOTH = 3 // samples either side that are averaged when measuring a corner
const STUCK_SPEED = 2 // m/s
const STUCK_TIME = 2 // seconds below STUCK_SPEED before the driver is put back on the road
const WRONG_WAY_SPEED = 12 // m/s; when the target is behind the car, turn round slowly

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export class AIDriver implements Updatable {
  /** The driver only drives while this is true. The race wiring switches it on at GO. */
  enabled = false
  readonly options: AIOptions

  private readonly car: Car
  private readonly controls: Controls
  private readonly track: TrackData
  private readonly speedLimits: Float32Array
  private index = -1 // nearest centre-line sample, also the search hint for the next step
  private stuck = 0 // seconds spent barely moving

  /** `controls` must be the same object the car was created with. */
  constructor(car: Car, controls: Controls, track: TrackData, options: Partial<AIOptions> = {}) {
    this.car = car
    this.controls = controls
    this.track = track
    this.options = { ...DEFAULT_AI_OPTIONS, ...options }
    this.speedLimits = this.buildSpeedLimits()
  }

  /** Forget everything about the last race. Call it when the car is put back on the grid. */
  reset(): void {
    this.index = -1
    this.stuck = 0
  }

  update(dt: number): void {
    const c = this.controls
    if (!this.enabled) {
      c.throttle = 0
      c.brake = 0
      c.steer = 0
      c.handbrake = false
      this.stuck = 0
      return
    }

    const car = this.car
    const track = this.track
    const o = this.options
    const cfg = car.config
    const n = track.samples.length

    this.index = track.nearestIndex(car.position.x, car.position.z, this.index)

    // The car's own axes, same convention as Car.updateAxes().
    const sin = Math.sin(car.heading)
    const cos = Math.cos(car.heading)
    const fx = -sin // forward
    const fz = -cos
    const rx = cos // right
    const rz = -sin

    const forwardSpeed = car.velocity.x * fx + car.velocity.z * fz
    const v = Math.max(0, forwardSpeed)

    // The carrot: a point on the track ahead of the car, shifted to this driver's lane.
    const lookAhead = o.lookAheadBase + o.lookAheadTime * v
    const target = track.sampleAt(this.index + Math.round(lookAhead / track.spacing))
    const dx = target.position.x + target.right.x * o.laneOffset - car.position.x
    const dz = target.position.z + target.right.z * o.laneOffset - car.position.z
    const lateral = dx * rx + dz * rz // positive: the carrot is to the right
    const ahead = dx * fx + dz * fz // negative: the carrot is behind the car

    // Planned speed for this part of the track, looking a moment ahead.
    const anticipate = this.index + Math.round((v * 0.2) / track.spacing)
    let targetSpeed = this.limitAt(anticipate % n)

    let steer: number
    if (ahead <= 0) {
      // Pointing away from where we need to go: full lock, and slow enough to turn round.
      steer = lateral >= 0 ? 1 : -1
      targetSpeed = Math.min(targetSpeed, WRONG_WAY_SPEED)
    } else {
      // Pure pursuit: the curvature of the arc that reaches the carrot is 2 x lateral / distance².
      // Turn that into the yaw rate it needs, then into the steering the car needs for that rate.
      const yawNeeded = (v * 2 * lateral) / (lateral * lateral + ahead * ahead)
      const authority = clamp(v / 5, 0, 1) * (1 - 0.5 * clamp(v / cfg.maxSpeed, 0, 1))
      if (authority > 0.1) {
        steer = (yawNeeded / (cfg.turnRate * authority)) * o.steerGain
      } else {
        steer = Math.atan2(lateral, ahead) * 1.5 // too slow for the maths above to mean much
      }
    }
    c.steer = clamp(steer, -1, 1)

    // Pedals: gas below the planned speed, brake clearly above it, coast in between.
    const error = targetSpeed - forwardSpeed
    c.throttle = clamp(error / 3, 0, 1)
    c.brake = clamp((-error - 1) / 5, 0, 1)
    c.handbrake = false

    // Stuck (wedged on a wall, say): put the car back on the centre line, facing the right way.
    if (car.velocity.length() < STUCK_SPEED) this.stuck += dt
    else this.stuck = 0
    if (this.stuck > STUCK_TIME) this.recover()
  }

  private limitAt(index: number): number {
    return this.speedLimits[index]!
  }

  private recover(): void {
    const s = this.track.sampleAt(this.index)
    const lane = this.options.laneOffset
    this.car.reset(
      s.position.x + s.right.x * lane,
      s.position.z + s.right.z * lane,
      Math.atan2(-s.tangent.x, -s.tangent.z), // same conversion as TrackData.poseAt()
    )
    this.stuck = 0
  }

  /** The fastest speed at each sample: limited by the corner, and by the braking needed for the next one. */
  private buildSpeedLimits(): Float32Array {
    const track = this.track
    const n = track.samples.length
    const spacing = track.spacing
    const o = this.options
    const topSpeed = this.car.config.maxSpeed * o.topSpeedFraction

    // How quickly the direction changes at each sample, per metre of road.
    const curvature = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const a = track.sampleAt(i).tangent
      const b = track.sampleAt(i + 1).tangent
      curvature[i] = Math.acos(clamp(a.dot(b), -1, 1)) / spacing
    }

    // Corner limit: v² / radius is the sideways acceleration, so v = sqrt(cornerAccel x radius).
    const limits = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let j = -SMOOTH; j <= SMOOTH; j++) sum += curvature[(i + j + n) % n]!
      const smoothed = sum / (2 * SMOOTH + 1)
      limits[i] = Math.min(topSpeed, Math.sqrt(o.cornerAccel / Math.max(smoothed, 1e-4)))
    }

    // Braking: a sample can be no faster than one from which the car can still slow down in
    // time for the next sample's limit. Two passes round the loop make the wrap-around settle.
    const decel = this.car.config.brakeDecel * BRAKE_PLAN
    for (let pass = 0; pass < 2; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const next = limits[(i + 1) % n]!
        const allowed = Math.sqrt(next * next + 2 * decel * spacing)
        if (allowed < limits[i]!) limits[i] = allowed
      }
    }
    return limits
  }
}