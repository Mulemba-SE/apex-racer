import type { Updatable } from '@/core/Game'
import {
  ASPHALT,
  CAR_HALF_LENGTH,
  CAR_HALF_WIDTH,
  GRASS,
  KERB,
  type Car,
  type SurfaceModifiers,
} from '@/entities/Car'
import type { TrackData } from '@/entities/TrackData'

const RESTITUTION = 0.25 // fraction of the impact speed that bounces back
const BOUNCE_THRESHOLD = 1.5 // m/s; gentler hits don't bounce, which stops jitter when scraping
const SCRUB_MIN = 0.1 // fraction of along-the-wall speed lost on any hit
const SCRUB_PER_MS = 0.02 // extra fraction lost per m/s of impact speed
const SCRUB_MAX = 0.5
const SPIN_GAIN = 0.03 // rad/s of spin per (m/s of impact x metre of lever arm)
const SKIN = 0.02 // metres of extra separation, so the car doesn't rest exactly on the wall

// [side, ahead]: which way along the car's right and forward axes each corner sits.
const CORNERS = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function surfaceFor(offset: number, track: TrackData): SurfaceModifiers {
  if (offset <= track.halfWidth) return ASPHALT
  if (offset <= track.grassOffset) return KERB
  return GRASS
}

export class TrackCollision implements Updatable {
  /** Called on every wall impact above 1 m/s, with the speed into the wall in m/s. */
  onImpact: ((speed: number) => void) | null = null

  private readonly car: Car
  private readonly track: TrackData
  private readonly blend: SurfaceModifiers = { grip: 1, traction: 1, drag: 0 }
  private index = -1 // nearest centre-line sample; the search hint for the next step

  constructor(car: Car, track: TrackData) {
    this.car = car
    this.track = track
  }

  update(): void {
    const car = this.car
    const track = this.track
    const px = car.position.x
    const pz = car.position.z

    this.index = track.nearestIndex(px, pz, this.index)

    // The car's own axes, same convention as Car.updateAxes().
    const sin = Math.sin(car.heading)
    const cos = Math.cos(car.heading)
    const fx = -sin // forward
    const fz = -cos
    const qx = cos // right
    const qz = -sin

    let grip = 0
    let traction = 0
    let drag = 0
    let depth = 0 // how far the deepest corner is past the wall
    let nx = 0 // wall normal at that corner, pointing back toward the road
    let nz = 0
    let ox = 0 // that corner's offset from the car centre
    let oz = 0

    for (const [side, ahead] of CORNERS) {
      const cornerX = fx * ahead * CAR_HALF_LENGTH + qx * side * CAR_HALF_WIDTH
      const cornerZ = fz * ahead * CAR_HALF_LENGTH + qz * side * CAR_HALF_WIDTH
      const x = px + cornerX
      const z = pz + cornerZ

      const i = track.nearestIndex(x, z, this.index)
      const lateral = track.lateralOffset(x, z, i)
      const offset = Math.abs(lateral)

      const m = surfaceFor(offset, track)
      grip += m.grip
      traction += m.traction
      drag += m.drag

      const over = offset - track.wallOffset
      if (over > depth) {
        depth = over
        const right = track.sampleAt(i).right
        const inward = lateral > 0 ? -1 : 1 // right wall pushes left, left wall pushes right
        nx = right.x * inward
        nz = right.z * inward
        ox = cornerX
        oz = cornerZ
      }
    }

    // Average the four corners and give the car the result.
    this.blend.grip = grip / 4
    this.blend.traction = traction / 4
    this.blend.drag = drag / 4
    car.surface = this.blend

    if (depth > 0) this.resolve(depth, nx, nz, ox, oz)
  }

  private resolve(depth: number, nx: number, nz: number, ox: number, oz: number): void {
    const car = this.car

    // Push the car back out of the wall.
    car.position.x += nx * (depth + SKIN)
    car.position.z += nz * (depth + SKIN)

    const v = car.velocity
    const vn = v.x * nx + v.z * nz // negative = moving into the wall
    if (vn >= 0) return // already moving away; the push-out was enough

    const impact = -vn
    const bounce = impact > BOUNCE_THRESHOLD ? RESTITUTION : 0
    const keep = 1 - clamp(SCRUB_MIN + SCRUB_PER_MS * impact, SCRUB_MIN, SCRUB_MAX)

    // Remove the into-the-wall part, scrub the along-the-wall part, then add the bounce.
    v.x = (v.x - vn * nx) * keep + nx * impact * bounce
    v.z = (v.z - vn * nz) * keep + nz * impact * bounce

    // Yaw torque about the vertical axis: lever arm (corner offset) crossed with the normal.
    // Positive turns the car left, which matches Car.kick().
    const torque = oz * nx - ox * nz
    car.kick(torque * impact * SPIN_GAIN)

    if (impact > 1) this.onImpact?.(impact)
  }
}