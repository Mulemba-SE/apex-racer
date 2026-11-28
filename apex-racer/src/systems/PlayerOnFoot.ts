import * as THREE from 'three'
import type { Updatable } from '@/core/Game'
import type { Input } from '@/core/Input'
import { CAR_HALF_LENGTH, CAR_HALF_WIDTH, type Car } from '@/entities/Car'
import type { CharacterAnimator } from '@/entities/CharacterAnimator'
import type { Character } from '@/entities/CharacterModel'
import type { Footprint } from '@/entities/Props'
import type { TrackProbe, TrackSpace } from '@/systems/TrackSpace'

/** A stretch of the track where the barriers are open: `half` metres either side of `along` (metres from the start line). */
export interface BarrierGap {
  along: number
  half: number
}

export interface PlayerOnFootOptions {
  character: Character
  animator: CharacterAnimator
  input: Input
  space: TrackSpace
  /** The direction the camera looks (FootCamera.yaw). W walks away from it. */
  cameraYaw: () => number
  /** Buildings she can't walk through. Pass `buildings.footprints`. */
  buildings: readonly Footprint[]
  /** Cars she can't walk through. */
  cars: readonly Car[]
}

const RADIUS = 0.3 // metres: the width of her body, as a circle
const WALK_SPEED = 1.7 // m/s
const RUN_SPEED = 5.2 // m/s
const SPEED_RATE = 12 // 1/s: how quickly she gets up to speed
const STOP_RATE = 16 // 1/s: how quickly she stops
const TURN_RATE = 8 // 1/s: how quickly she turns to face where she is going
const GRASS_DROP = -0.1 // the grass is this far below the road, in metres

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** Shortest signed difference between two angles, in -PI..PI. */
function angleDiff(target: number, current: number): number {
  const d = target - current
  return Math.atan2(Math.sin(d), Math.cos(d))
}

/** Distance from the point (px, pz) to a rectangle: its centre, half sizes and turn about the vertical axis. Zero inside. */
function distanceToRect(px: number, pz: number, cx: number, cz: number, hw: number, hd: number, rot: number): number {
  const dx = px - cx
  const dz = pz - cz
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const lx = c * dx - s * dz // the point in the rectangle's own space
  const lz = s * dx + c * dz
  return Math.hypot(lx - clamp(lx, -hw, hw), lz - clamp(lz, -hd, hd))
}

export class PlayerOnFoot implements Updatable {
  /** Add this to the scene (it is the character's own object). It is hidden while she is in the car. */
  readonly object: THREE.Object3D
  /** True while she is walking around, false while she is in the car. */
  active = false
  /** The way she faces, in the same convention as a car's heading: 0 faces -Z, and positive turns left. */
  heading = 0
  /** Her simulated position. The drawn position, between steps, is set by interpolate(). */
  readonly position = new THREE.Vector3()

  private readonly animator: CharacterAnimator
  private readonly input: Input
  private readonly space: TrackSpace
  private readonly cameraYaw: () => number
  private readonly buildings: readonly Footprint[]
  private readonly cars: readonly Car[]
  private gaps: readonly BarrierGap[] = []

  private vx = 0
  private vz = 0
  private readonly prev = new THREE.Vector3()
  private prevHeading = 0
  private readonly probeNow: TrackProbe = { distance: 0, lateral: 0, index: 0, along: 0 }
  private readonly probeBefore: TrackProbe = { distance: 0, lateral: 0, index: 0, along: 0 }

  constructor(options: PlayerOnFootOptions) {
    this.object = options.character.object
    this.animator = options.animator
    this.input = options.input
    this.space = options.space
    this.cameraYaw = options.cameraYaw
    this.buildings = options.buildings
    this.cars = options.cars
    this.object.visible = false
  }

  /** How fast she is moving over the ground, in m/s. */
  get speed(): number {
    return Math.hypot(this.vx, this.vz)
  }

  /** Stretches of the track where she can walk through the barriers. */
  setBarrierGaps(gaps: readonly BarrierGap[]): void {
    this.gaps = gaps
  }

  /** How far her body is from a car, in metres. Zero means touching. */
  distanceToCar(car: Car): number {
    return distanceToRect(this.position.x, this.position.z, car.position.x, car.position.z, CAR_HALF_WIDTH, CAR_HALF_LENGTH, car.heading)
  }

  /** Puts her on foot beside `car`, on the first free spot, facing away from it. */
  getOut(car: Car): void {
    const s = Math.sin(car.heading)
    const c = Math.cos(car.heading)
    const side = CAR_HALF_WIDTH + 0.7
    const end = CAR_HALF_LENGTH + 0.7
    // The car's right is (c, -s) and its forward is (-s, -c). Try the left, the right, behind, then in front.
    const options = [
      { ox: -c, oz: s, distance: side },
      { ox: c, oz: -s, distance: side },
      { ox: s, oz: c, distance: end },
      { ox: -s, oz: -c, distance: end },
    ]
    let chosen = options[0]!
    for (const o of options) {
      if (this.isFree(car.position.x + o.ox * o.distance, car.position.z + o.oz * o.distance)) {
        chosen = o
        break
      }
    }
    this.position.set(car.position.x + chosen.ox * chosen.distance, 0, car.position.z + chosen.oz * chosen.distance)
    this.heading = Math.atan2(-chosen.ox, -chosen.oz) // facing away from the car
    this.prev.copy(this.position)
    this.prevHeading = this.heading
    this.vx = 0
    this.vz = 0
    this.active = true
    this.object.visible = true
    this.interpolate(1)
  }

  /** Hides her, for when she is back in the car. */
  getIn(): void {
    this.active = false
    this.vx = 0
    this.vz = 0
    this.object.visible = false
  }

  /** Fixed-step update: reads the walking controls, moves her, and keeps her out of cars, buildings and barriers. */
  update(dt: number): void {
    if (!this.active) return
    this.prev.copy(this.position)
    this.prevHeading = this.heading

    // The direction she wants to go, relative to the camera. The camera's forward is (-sin, -cos) and its right is (cos, -sin).
    const f = this.input.foot
    const yaw = this.cameraYaw()
    const s = Math.sin(yaw)
    const c = Math.cos(yaw)
    let dx = -s * f.forward + c * f.strafe
    let dz = -c * f.forward - s * f.strafe
    const length = Math.hypot(dx, dz)
    if (length > 1) {
      dx /= length
      dz /= length
    }
    const moving = length > 0.01
    const top = f.run ? RUN_SPEED : WALK_SPEED

    const ease = 1 - Math.exp(-(moving ? SPEED_RATE : STOP_RATE) * dt)
    this.vx += (dx * top - this.vx) * ease
    this.vz += (dz * top - this.vz) * ease

    // Turn to face where she is going. She keeps her facing while standing still.
    if (moving) {
      const wanted = Math.atan2(-dx, -dz)
      this.heading += angleDiff(wanted, this.heading) * (1 - Math.exp(-TURN_RATE * dt))
    }

    this.position.x += this.vx * dt
    this.position.z += this.vz * dt
    this.resolve()
    this.resolve() // a second pass settles a corner, where two things push her at once

    // Stand on the road, or a little lower on the grass.
    const d = this.space.probe(this.position.x, this.position.z, this.probeNow).distance
    const ground = d <= this.space.track.grassOffset ? 0 : GRASS_DROP
    this.position.y += (ground - this.position.y) * (1 - Math.exp(-30 * dt))
  }

  /** Places her drawn position between her last two steps. Call once per display frame, while she is on foot. */
  interpolate(alpha: number): void {
    this.object.position.lerpVectors(this.prev, this.position, alpha)
    this.object.rotation.y = this.prevHeading + angleDiff(this.heading, this.prevHeading) * alpha
  }

  /** Plays the walk or run for her current speed. Call once per display frame, while she is on foot. */
  animate(dt: number): void {
    this.animator.update(dt, this.active ? this.speed : 0)
  }

  /** True when a person could stand at (x, z): clear of every car and building, and on the road side of the barrier. */
  private isFree(x: number, z: number): boolean {
    const r = RADIUS + 0.05
    for (const car of this.cars) {
      if (distanceToRect(x, z, car.position.x, car.position.z, CAR_HALF_WIDTH, CAR_HALF_LENGTH, car.heading) < r) return false
    }
    for (const b of this.buildings) {
      if (distanceToRect(x, z, b.cx, b.cz, b.hw, b.hd, b.rot) < r) return false
    }
    return this.space.probe(x, z, this.probeNow).distance < this.space.track.wallOffset - r
  }

  private resolve(): void {
    for (const car of this.cars) {
      this.collideRect(car.position.x, car.position.z, CAR_HALF_WIDTH, CAR_HALF_LENGTH, car.heading)
    }
    for (const b of this.buildings) this.collideRect(b.cx, b.cz, b.hw, b.hd, b.rot)
    this.collideBarrier()
  }

  /** Pushes her out of a rectangle, and takes away the part of her speed that was going into it. */
  private collideRect(cx: number, cz: number, hw: number, hd: number, rot: number): void {
    const dx = this.position.x - cx
    const dz = this.position.z - cz
    const reach = hw + hd + RADIUS
    if (dx * dx + dz * dz > reach * reach) return // too far away to touch

    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const lx = c * dx - s * dz // her position in the rectangle's own space
    const lz = s * dx + c * dz
    const ox = lx - clamp(lx, -hw, hw) // from the nearest point of the rectangle to her
    const oz = lz - clamp(lz, -hd, hd)
    const d2 = ox * ox + oz * oz
    if (d2 >= RADIUS * RADIUS) return

    let nx: number
    let nz: number
    let push: number
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2)
      nx = ox / d
      nz = oz / d
      push = RADIUS - d
    } else {
      // Her middle is inside the rectangle: leave through the nearest side.
      const px = hw - Math.abs(lx)
      const pz = hd - Math.abs(lz)
      if (px < pz) {
        nx = Math.sign(lx) || 1
        nz = 0
        push = px + RADIUS
      } else {
        nx = 0
        nz = Math.sign(lz) || 1
        push = pz + RADIUS
      }
    }
    // Back into the world: world = (c * lx + s * lz, -s * lx + c * lz).
    const wx = c * nx + s * nz
    const wz = -s * nx + c * nz
    this.position.x += wx * push
    this.position.z += wz * push
    const into = this.vx * wx + this.vz * wz
    if (into < 0) {
      this.vx -= into * wx
      this.vz -= into * wz
    }
  }

  /** Keeps her on whichever side of the barrier she was on, unless she is in a gap. */
  private collideBarrier(): void {
    const space = this.space
    const track = space.track
    const inner = track.wallOffset // distance from the centre line to the barrier's inner face
    const outer = space.outerEdge // and to its outer face

    const now = space.probe(this.position.x, this.position.z, this.probeNow)
    const d = now.distance
    if (d <= inner - RADIUS || d >= outer + RADIUS) return // clear of the barrier
    if (this.inGap(now.along)) return

    // Which side was she on a moment ago? She stays on that side.
    const before = space.probe(this.prev.x, this.prev.z, this.probeBefore).distance
    let target: number
    if (before <= inner - RADIUS * 0.5) target = inner - RADIUS
    else if (before >= outer + RADIUS * 0.5) target = outer + RADIUS
    else target = d < (inner + outer) / 2 ? inner - RADIUS : outer + RADIUS

    const side = Math.sign(now.lateral) || 1 // which side of the road she is on
    const right = track.sampleAt(now.index).right
    const shift = (target - d) * side
    this.position.x += right.x * shift
    this.position.z += right.z * shift

    // The wall's direction of push: away from the barrier, toward where she came from.
    const nx = right.x * side * Math.sign(target - d)
    const nz = right.z * side * Math.sign(target - d)
    const into = this.vx * nx + this.vz * nz
    if (into < 0) {
      this.vx -= into * nx
      this.vz -= into * nz
    }
  }

  private inGap(along: number): boolean {
    const length = this.space.track.length
    for (const g of this.gaps) {
      let d = Math.abs(along - g.along) % length
      d = Math.min(d, length - d) // the loop wraps round at the start line
      if (d < g.half) return true
    }
    return false
  }
}