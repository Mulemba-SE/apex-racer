import type { Updatable } from '@/core/Game'
import { CAR_HALF_LENGTH, CAR_HALF_WIDTH, type Car } from '@/entities/Car'

const RESTITUTION = 0.3 // fraction of the closing speed that bounces back
const BOUNCE_THRESHOLD = 1.5 // m/s; gentler contacts don't bounce, which stops jitter when cars rub together
const FRICTION_MIN = 0.05 // fraction of the sideways speed difference removed on any contact
const FRICTION_PER_MS = 0.01 // extra fraction removed per m/s of closing speed
const FRICTION_MAX = 0.25
const SPIN_GAIN = 0.02 // rad/s of spin per (m/s of impact x metre of lever arm)
const SKIN = 0.01 // metres of extra separation, so cars don't rest exactly touching
const BROAD_RADIUS = 2 * Math.hypot(CAR_HALF_WIDTH, CAR_HALF_LENGTH) // farther apart than this: cannot touch

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** One car's footprint: its centre, forward axis and right axis (same convention as Car.updateAxes()). */
interface Box {
  x: number
  z: number
  fx: number
  fz: number
  rx: number
  rz: number
}

function makeBox(): Box {
  return { x: 0, z: 0, fx: 0, fz: 0, rx: 0, rz: 0 }
}

function fillBox(box: Box, car: Car): void {
  const sin = Math.sin(car.heading)
  const cos = Math.cos(car.heading)
  box.x = car.position.x
  box.z = car.position.z
  box.fx = -sin
  box.fz = -cos
  box.rx = cos
  box.rz = -sin
}

export class CarCollision implements Updatable {
  /** Called on every car-to-car impact above 1 m/s, with the closing speed in m/s and the two cars. */
  onImpact: ((speed: number, a: Car, b: Car) => void) | null = null

  private readonly cars: readonly Car[]

  // Scratch space, reused every step so the loop creates no garbage.
  private readonly boxA = makeBox()
  private readonly boxB = makeBox()
  private depth = 0 // smallest overlap found so far
  private nx = 0 // push direction at that overlap, pointing from car A to car B
  private nz = 0
  private sx = 0 // running total of the contact points
  private sz = 0
  private count = 0

  constructor(cars: readonly Car[]) {
    this.cars = cars
  }

  update(): void {
    const cars = this.cars
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) this.test(cars[i]!, cars[j]!)
    }
  }

  private test(a: Car, b: Car): void {
    const dx = b.position.x - a.position.x
    const dz = b.position.z - a.position.z
    if (dx * dx + dz * dz > BROAD_RADIUS * BROAD_RADIUS) return // quick rejection: too far apart

    const A = this.boxA
    const B = this.boxB
    fillBox(A, a)
    fillBox(B, b)

    // Separating-axis test. If there is any axis along which the two rectangles don't
    // overlap, the cars aren't touching. Otherwise the axis of least overlap is the way out.
    this.depth = Infinity
    if (!this.axis(A.fx, A.fz, dx, dz)) return
    if (!this.axis(A.rx, A.rz, dx, dz)) return
    if (!this.axis(B.fx, B.fz, dx, dz)) return
    if (!this.axis(B.rx, B.rz, dx, dz)) return

    // Where they touch: the average of every corner of one car that lies inside the other.
    this.sx = 0
    this.sz = 0
    this.count = 0
    this.collect(A, B)
    this.collect(B, A)
    const cx = this.count > 0 ? this.sx / this.count : (a.position.x + b.position.x) / 2
    const cz = this.count > 0 ? this.sz / this.count : (a.position.z + b.position.z) / 2

    this.resolve(a, b, cx, cz)
  }

  /** Tests one candidate axis. Returns false when the cars are apart along it. */
  private axis(lx: number, lz: number, dx: number, dz: number): boolean {
    const A = this.boxA
    const B = this.boxB
    // How far each rectangle reaches along this axis from its centre.
    const reachA =
      CAR_HALF_LENGTH * Math.abs(A.fx * lx + A.fz * lz) + CAR_HALF_WIDTH * Math.abs(A.rx * lx + A.rz * lz)
    const reachB =
      CAR_HALF_LENGTH * Math.abs(B.fx * lx + B.fz * lz) + CAR_HALF_WIDTH * Math.abs(B.rx * lx + B.rz * lz)
    const dist = dx * lx + dz * lz // signed distance between the centres along the axis
    const overlap = reachA + reachB - Math.abs(dist)
    if (overlap <= 0) return false

    if (overlap < this.depth) {
      this.depth = overlap
      const sign = dist < 0 ? -1 : 1 // orient the axis from A toward B
      this.nx = lx * sign
      this.nz = lz * sign
    }
    return true
  }

  /** Adds each corner of `from` that lies inside `into` to the running contact total. */
  private collect(from: Box, into: Box): void {
    for (let i = -1; i <= 1; i += 2) {
      for (let j = -1; j <= 1; j += 2) {
        const px = from.x + from.fx * CAR_HALF_LENGTH * i + from.rx * CAR_HALF_WIDTH * j
        const pz = from.z + from.fz * CAR_HALF_LENGTH * i + from.rz * CAR_HALF_WIDTH * j
        const ox = px - into.x
        const oz = pz - into.z
        const along = Math.abs(ox * into.fx + oz * into.fz)
        const across = Math.abs(ox * into.rx + oz * into.rz)
        if (along <= CAR_HALF_LENGTH && across <= CAR_HALF_WIDTH) {
          this.sx += px
          this.sz += pz
          this.count++
        }
      }
    }
  }

  private resolve(a: Car, b: Car, cx: number, cz: number): void {
    const nx = this.nx
    const nz = this.nz

    // Lever arms from each car's centre to the contact point, taken before the cars move apart.
    const ax = cx - a.position.x
    const az = cz - a.position.z
    const bx = cx - b.position.x
    const bz = cz - b.position.z

    // Push the cars apart, half each (they weigh the same).
    const push = this.depth / 2 + SKIN
    a.position.x -= nx * push
    a.position.z -= nz * push
    b.position.x += nx * push
    b.position.z += nz * push

    // Relative velocity of B as seen from A, split into along-the-normal and sideways.
    const rvx = b.velocity.x - a.velocity.x
    const rvz = b.velocity.z - a.velocity.z
    const closing = rvx * nx + rvz * nz // negative = the cars are approaching each other
    if (closing >= 0) return // already moving apart; the push was enough

    const impact = -closing
    const bounce = impact > BOUNCE_THRESHOLD ? RESTITUTION : 0
    const j = ((1 + bounce) * impact) / 2 // equal masses: each car takes half the change
    a.velocity.x -= nx * j
    a.velocity.z -= nz * j
    b.velocity.x += nx * j
    b.velocity.z += nz * j

    // Friction between the two bodies: pull their sideways speeds toward each other.
    const tx = rvx - closing * nx
    const tz = rvz - closing * nz
    const friction = clamp(FRICTION_MIN + FRICTION_PER_MS * impact, FRICTION_MIN, FRICTION_MAX)
    a.velocity.x += (tx * friction) / 2
    a.velocity.z += (tz * friction) / 2
    b.velocity.x -= (tx * friction) / 2
    b.velocity.z -= (tz * friction) / 2

    // Spin: torque about the vertical axis is lever arm crossed with the force, same sign
    // convention as TrackCollision (positive turns the car left). A is pushed along -n, B along +n.
    a.kick(-(az * nx - ax * nz) * impact * SPIN_GAIN)
    b.kick((bz * nx - bx * nz) * impact * SPIN_GAIN)

    if (impact > 1) this.onImpact?.(impact, a, b)
  }
}