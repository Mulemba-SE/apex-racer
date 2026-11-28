import * as THREE from 'three'
import type { Footprint } from '@/entities/Props'

export interface FootCameraConfig {
  distance: number // metres behind the character when walking
  runDistance: number // metres behind when running
  pivotHeight: number // the point the camera orbits and looks at, in metres above her feet
  shoulder: number // metres the view is shifted to the right of her
  pitch: number // the starting elevation of the camera above the pivot, in radians
  pitchMin: number // lowest elevation: slightly below the pivot
  pitchMax: number // highest elevation: looking mostly down
  fov: number // degrees, standing or walking
  runFov: number // degrees, at a full run
  near: number
  lookSensitivity: number // radians of turning per pixel of mouse drag
  keyLookRate: number // radians per second when turning with the Q and E keys
  blendSeconds: number // how long the glide from the previous camera takes
}

export const DEFAULT_FOOT_CAMERA: FootCameraConfig = {
  distance: 3.6,
  runDistance: 4.5,
  pivotHeight: 1.55,
  shoulder: 0.32,
  pitch: 0.2,
  pitchMin: -0.3,
  pitchMax: 1.25,
  fov: 62,
  runFov: 70,
  near: 0.25,
  lookSensitivity: 0.0035,
  keyLookRate: 1.8,
  blendSeconds: 0.6,
}

const UP = new THREE.Vector3(0, 1, 0)
const MIN_DISTANCE = 0.9 // the camera never comes closer than this, even against a wall
const MIN_HEIGHT = 0.35 // the camera never goes below this, so it can't dip under the ground
const OBSTACLE_MARGIN = 0.45 // metres the camera keeps from a building
const OBSTACLE_STEP = 0.4 // metres between the points checked along the line to the camera
const PIVOT_RATE = 14 // 1/s: how quickly the pivot follows the character
const RECOVER_RATE = 4 // 1/s: how quickly the camera slides back out after an obstruction
const RUN_SPEED = 4.5 // m/s at which the run effects are complete

/** Exponential smoothing factor that behaves the same at any frame rate. */
function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt)
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** Where the camera is, which way it faces and how it is lensed. */
interface Pose {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  fov: number
  near: number
}

function makePose(): Pose {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 62, near: 0.25 }
}

export class FootCamera {
  /** Every number that shapes the camera. Safe to change live, e.g. in the browser console: footCam.config.distance = 5 */
  readonly config: FootCameraConfig

  private readonly camera: THREE.PerspectiveCamera
  private readonly target: THREE.Object3D // the character
  private obstacles: readonly Footprint[] = []

  private heading = 0 // the direction the camera looks, in the same convention as a car's heading
  private elevation: number
  private distance: number // the current distance, shorter while something is in the way
  private runAmount = 0 // 0 walking, 1 running, smoothed

  private readonly pivot = new THREE.Vector3()
  private havePivot = false

  // A switch from the previous camera blends from where it was to where this one wants to be.
  private blend = 1
  private readonly from = makePose()

  private readonly base = new THREE.Vector3()
  private readonly aim = new THREE.Vector3()
  private readonly goal = new THREE.Vector3()
  private readonly dir = new THREE.Vector3()
  private readonly right = new THREE.Vector3()
  private readonly flat = new THREE.Vector3()
  private readonly matrix = new THREE.Matrix4()
  private readonly goalQuat = new THREE.Quaternion()

  constructor(camera: THREE.PerspectiveCamera, target: THREE.Object3D, config: Partial<FootCameraConfig> = {}) {
    this.camera = camera
    this.target = target
    this.config = { ...DEFAULT_FOOT_CAMERA, ...config }
    this.elevation = this.config.pitch
    this.distance = this.config.distance
  }

  /** The direction the camera looks, in the same convention as a car's heading: 0 faces -Z, and positive turns left. Walking is relative to this. */
  get yaw(): number {
    return this.heading
  }

  /** Buildings the camera must not move into. Pass `buildings.footprints`. */
  setObstacles(obstacles: readonly Footprint[]): void {
    this.obstacles = obstacles
  }

  /**
   * Takes over the camera. It starts looking along `yaw` (the character's heading is a good choice), and
   * glides from wherever the camera is now, unless `instant` is true.
   */
  activate(yaw: number, instant = false): void {
    this.from.position.copy(this.camera.position)
    this.from.quaternion.copy(this.camera.quaternion)
    this.from.fov = this.camera.fov
    this.from.near = this.camera.near
    this.heading = yaw
    this.elevation = this.config.pitch
    this.distance = this.config.distance
    this.runAmount = 0
    this.havePivot = false
    this.blend = instant ? 1 : 0
  }

  /**
   * Call once per display frame while the character is on foot. `lookX` and `lookY` are the pixels the mouse
   * moved while dragging with the right button (Input.takeLook), `keyLook` is -1 to 1 from the Q and E keys,
   * and `speed` is the character's speed over the ground in m/s.
   */
  update(dt: number, lookX: number, lookY: number, keyLook: number, speed: number): void {
    const cfg = this.config

    // Turning: dragging right or pressing E turns the view right, which lowers the heading.
    this.heading -= lookX * cfg.lookSensitivity + keyLook * cfg.keyLookRate * dt
    this.elevation = clamp(this.elevation + lookY * cfg.lookSensitivity, cfg.pitchMin, cfg.pitchMax)

    // The point the camera orbits: above the character's feet. It follows with a little smoothing.
    this.target.getWorldPosition(this.base)
    this.aim.set(this.base.x, this.base.y + cfg.pivotHeight, this.base.z)
    if (!this.havePivot) {
      this.pivot.copy(this.aim)
      this.havePivot = true
    } else {
      this.pivot.lerp(this.aim, damp(PIVOT_RATE, dt))
    }

    this.runAmount += (clamp(speed / RUN_SPEED, 0, 1) - this.runAmount) * damp(3, dt)
    const wantedDistance = cfg.distance + (cfg.runDistance - cfg.distance) * this.runAmount

    // The view direction on the ground, and to the character's right of it.
    const s = Math.sin(this.heading)
    const c = Math.cos(this.heading)
    this.flat.set(-s, 0, -c)
    this.right.set(c, 0, -s)

    // The aim point is shifted to the right, so the character sits left of centre.
    this.aim.copy(this.pivot).addScaledVector(this.right, cfg.shoulder)

    // The camera sits behind the aim point and above it, on a line set by the elevation.
    const cosE = Math.cos(this.elevation)
    this.dir.copy(this.flat).multiplyScalar(-cosE).addScaledVector(UP, Math.sin(this.elevation)) // from the aim point toward the camera

    // Slide the camera toward the character when a building is in the way, and ease it back out afterwards.
    const clear = this.clearDistance(this.aim, this.dir, wantedDistance)
    if (clear < this.distance) this.distance = clear
    else this.distance += (clear - this.distance) * damp(RECOVER_RATE, dt)

    this.goal.copy(this.aim).addScaledVector(this.dir, this.distance)
    this.goal.y = Math.max(this.goal.y, MIN_HEIGHT)

    this.matrix.lookAt(this.goal, this.aim, UP)
    this.goalQuat.setFromRotationMatrix(this.matrix)
    const fov = cfg.fov + (cfg.runFov - cfg.fov) * this.runAmount

    // Apply it, blending from the previous camera for the first moments.
    const camera = this.camera
    if (this.blend >= 1) {
      camera.position.copy(this.goal)
      camera.quaternion.copy(this.goalQuat)
      this.applyLens(fov, cfg.near)
    } else {
      this.blend = Math.min(1, this.blend + dt / cfg.blendSeconds)
      const e = this.blend * this.blend * (3 - 2 * this.blend)
      camera.position.lerpVectors(this.from.position, this.goal, e)
      camera.quaternion.slerpQuaternions(this.from.quaternion, this.goalQuat, e)
      this.applyLens(this.from.fov + (fov - this.from.fov) * e, this.from.near + (cfg.near - this.from.near) * e)
    }
  }

  private applyLens(fov: number, near: number): void {
    const camera = this.camera
    if (Math.abs(camera.fov - fov) > 0.01 || Math.abs(camera.near - near) > 0.0001) {
      camera.fov = fov
      camera.near = near
      camera.updateProjectionMatrix()
    }
  }

  /** How far the camera can go along `dir` from `origin` before it would be inside a building, up to `max`. */
  private clearDistance(origin: THREE.Vector3, dir: THREE.Vector3, max: number): number {
    if (this.obstacles.length === 0) return max
    for (let t = OBSTACLE_STEP; t <= max; t += OBSTACLE_STEP) {
      if (this.blocked(origin.x + dir.x * t, origin.z + dir.z * t)) {
        return Math.max(MIN_DISTANCE, t - OBSTACLE_STEP - 0.2)
      }
    }
    return max
  }

  /** True when the point is inside a building, or within a camera margin of one. */
  private blocked(x: number, z: number): boolean {
    for (const f of this.obstacles) {
      const dx = x - f.cx
      const dz = z - f.cz
      const reach = f.hw + f.hd + OBSTACLE_MARGIN // a circle that surely holds the building, for a quick rejection
      if (dx * dx + dz * dz > reach * reach) continue
      const c = Math.cos(f.rot)
      const s = Math.sin(f.rot)
      // The point in the building's own space.
      const lx = c * dx - s * dz
      const lz = s * dx + c * dz
      if (Math.abs(lx) < f.hw + OBSTACLE_MARGIN && Math.abs(lz) < f.hd + OBSTACLE_MARGIN) return true
    }
    return false
  }
}