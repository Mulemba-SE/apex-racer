
import * as THREE from 'three'
import type { Car, CarViewPoint } from '@/entities/Car'

/** The camera views. Each one is a rule that turns the car's transform into a camera pose. */
export type CameraMode = 'chase' | 'far' | 'hood' | 'cockpit'

/** The order the views come in when the camera key is pressed. */
export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'far', 'hood', 'cockpit']

export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: 'CHASE',
  far: 'FAR CHASE',
  hood: 'HOOD',
  cockpit: 'COCKPIT',
}

/** A chase-style view: the camera trails the car and swings round behind it with a delay. */
export interface CameraRigConfig {
  distance: number
  extraDistance: number
  height: number
  lookAhead: number
  lookHeight: number
  headingLag: number
  fovBase: number
  fovMax: number
  fovResponse: number
  near: number
}

/** A first-person view: the camera is bolted to the car and copies its rotation, with no lag. */
export interface FirstPersonConfig {
  anchor: CarViewPoint
  near: number
  fovBase: number
  fovMax: number
  steerYaw: number
  shake: number
  hide: RegExp | null
}

export const DEFAULT_CAMERA_CONFIG: CameraRigConfig = {
  distance: 7,
  extraDistance: 2.5,
  height: 2.8,
  lookAhead: 6,
  lookHeight: 1.2,
  headingLag: 5,
  fovBase: 65,
  fovMax: 85,
  fovResponse: 3,
  near: 0.3,
}

export const FAR_CAMERA_CONFIG: CameraRigConfig = {
  ...DEFAULT_CAMERA_CONFIG,
  distance: 11,
  extraDistance: 4,
  height: 4.6,
  lookAhead: 9,
  lookHeight: 1,
  fovBase: 60,
  fovMax: 78,
}

/**
 * Parts of the model that sit in the driver's line of sight.
 */
export const COCKPIT_HIDE = /^wiper$/i

export const FIRST_PERSON_VIEWS: Record<'hood' | 'cockpit', FirstPersonConfig> = {
  hood: {
    anchor: 'hood',
    near: 0.1,
    fovBase: 75,
    fovMax: 88,
    steerYaw: 0.1,
    shake: 0.6,
    hide: null,
  },
  cockpit: {
    anchor: 'cockpit',
    near: 0.1,
    fovBase: 80,
    fovMax: 92,
    steerYaw: 0.14,
    shake: 1,
    hide: COCKPIT_HIDE,
  },
}

const BLEND_SECONDS = 0.35
const SHAKE_ROTATION = 0.002
const SHAKE_LIFT = 0.003
const UP = new THREE.Vector3(0, 1, 0)

/** Exponential smoothing factor that behaves the same at any frame rate. */
function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt)
}

/** Shortest signed difference between two angles, in -PI..PI. */
function angleDiff(target: number, current: number): number {
  const d = target - current
  return Math.atan2(Math.sin(d), Math.cos(d))
}

function isFirstPerson(mode: CameraMode): mode is 'hood' | 'cockpit' {
  return mode === 'hood' || mode === 'cockpit'
}

/** Where the camera is, which way it faces and how it is lensed. */
interface Pose {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  fov: number
  near: number
}

function makePose(): Pose {
  return {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    fov: 65,
    near: 0.3,
  }
}

export class CameraRig {
  /** Settings of the 'chase' view. Edit these to tune it. */
  readonly config: CameraRigConfig

  /** Settings of the 'far' view. */
  readonly farConfig: CameraRigConfig

  /** Settings of the 'hood' and 'cockpit' views. */
  readonly firstPerson: Record<'hood' | 'cockpit', FirstPersonConfig>

  private readonly camera: THREE.PerspectiveCamera
  private readonly target: Car

  private current: CameraMode = 'chase'
  private chaseHeading = 0
  private chaseFov: number
  private time = 0

  // A switch between views blends from where the camera was to where the new view wants it.
  // The start pose is stored relative to the car, so the blend keeps moving with the car.
  private blend = 1
  private readonly from = makePose()
  private readonly goal = makePose()
  private readonly shown = makePose()

  private readonly forward = new THREE.Vector3()
  private readonly aim = new THREE.Vector3()
  private readonly offset = new THREE.Vector3()
  private readonly scale = new THREE.Vector3()
  private readonly fromPosition = new THREE.Vector3()
  private readonly fromQuaternion = new THREE.Quaternion()
  private readonly turn = new THREE.Quaternion()
  private readonly euler = new THREE.Euler()
  private readonly matrix = new THREE.Matrix4()

  constructor(
    camera: THREE.PerspectiveCamera,
    target: Car,
    config: Partial<CameraRigConfig> = {},
  ) {
    this.camera = camera
    this.target = target
    this.config = { ...DEFAULT_CAMERA_CONFIG, ...config }
    this.farConfig = { ...FAR_CAMERA_CONFIG }

    this.firstPerson = {
      hood: { ...FIRST_PERSON_VIEWS.hood },
      cockpit: { ...FIRST_PERSON_VIEWS.cockpit },
    }

    this.chaseFov = this.config.fovBase
    this.snap()
  }

  get mode(): CameraMode {
    return this.current
  }

  /** Switches to a view, blending over a third of a second. */
  setMode(mode: CameraMode, instant = false): void {
    if (mode === this.current) return

    // Remember where the camera is now, in the car's space, before the view changes.
    const car = this.target.object

    car.updateMatrixWorld(true)

    this.from.position.copy(this.camera.position)
    car.worldToLocal(this.from.position)

    this.from.quaternion
      .copy(car.quaternion)
      .invert()
      .multiply(this.camera.quaternion)

    this.from.fov = this.camera.fov
    this.from.near = this.camera.near

    this.current = mode

    this.target.setHiddenMaterials(
      isFirstPerson(mode) ? this.firstPerson[mode].hide : null,
    )

    this.blend = instant ? 1 : 0

    if (instant) {
      this.computeGoal()
      this.blendAndApply(0)
    }
  }

  /** Moves on to the next view in CAMERA_MODES and returns it. */
  cycle(): CameraMode {
    const next =
      CAMERA_MODES[(CAMERA_MODES.indexOf(this.current) + 1) % CAMERA_MODES.length]!

    this.setMode(next)

    return next
  }

  /** Call once per display frame, after the car's visual transform is updated. */
  update(frameDt: number): void {
    this.time += frameDt

    // Update the car and all camera anchors before reading their world transforms.
    this.target.object.updateMatrixWorld(true)

    this.followChase(frameDt)
    this.computeGoal()
    this.blendAndApply(frameDt)
  }

  /** Jump straight to the ideal pose with no smoothing. Use after a reset. */
  snap(): void {
    const cfg = this.chaseConfig()

    this.chaseHeading = this.target.object.rotation.y
    this.chaseFov = cfg.fovBase
    this.blend = 1

    this.target.object.updateMatrixWorld(true)

    this.computeGoal()
    this.blendAndApply(0)
  }

  private chaseConfig(): CameraRigConfig {
    return this.current === 'far' ? this.farConfig : this.config
  }

  private speedFraction(): number {
    const car = this.target
    const fraction = car.velocity.length() / car.config.maxSpeed

    return Math.min(1, Math.max(0, fraction))
  }

  /**
   * Keeps the chase heading and chase field of view moving even while a first-person view is
   * showing, so switching back to a chase view doesn't start from something stale.
   */
  private followChase(frameDt: number): void {
    const cfg = this.chaseConfig()

    // Swing the chase heading toward the car's heading.
    const carHeading = this.target.object.rotation.y

    this.chaseHeading +=
      angleDiff(carHeading, this.chaseHeading) *
      damp(cfg.headingLag, frameDt)

    // The field of view widens with speed.
    const targetFov =
      cfg.fovBase + (cfg.fovMax - cfg.fovBase) * this.speedFraction()

    this.chaseFov +=
      (targetFov - this.chaseFov) *
      damp(cfg.fovResponse, frameDt)
  }

  private computeGoal(): void {
    const mode = this.current

    if (isFirstPerson(mode)) {
      this.firstPersonPose(this.firstPerson[mode])
    } else {
      this.chasePose(this.chaseConfig())
    }
  }

  /** Behind the car and aimed just ahead of it, lagging so drifts stay readable. */
  private chasePose(cfg: CameraRigConfig): void {
    const goal = this.goal
    const carPos = this.target.object.position

    // Unit vector the car "should" be facing, from the smoothed heading.
    this.forward.set(
      -Math.sin(this.chaseHeading),
      0,
      -Math.cos(this.chaseHeading),
    )

    const distance =
      cfg.distance + cfg.extraDistance * this.speedFraction()

    goal.position
      .copy(carPos)
      .addScaledVector(this.forward, -distance)
      .setY(cfg.height)

    this.aim
      .copy(carPos)
      .addScaledVector(this.forward, cfg.lookAhead)
      .setY(cfg.lookHeight)

    this.matrix.lookAt(goal.position, this.aim, UP)
    goal.quaternion.setFromRotationMatrix(this.matrix)

    goal.fov = this.chaseFov
    goal.near = cfg.near
  }

  /** On a mount on the car's body: no lag, and it copies the body's rotation, roll included. */
  private firstPersonPose(cfg: FirstPersonConfig): void {
    const goal = this.goal
    const car = this.target
    const speed = this.speedFraction()

    const anchor = car.viewAnchors[cfg.anchor]

    // Ensure the anchor and its parents have current world transforms.
    anchor.updateWorldMatrix(true, false)

    anchor.matrixWorld.decompose(
      goal.position,
      goal.quaternion,
      this.scale,
    )

    // Look a little into the corner.
    this.turn.setFromAxisAngle(UP, -car.steering * cfg.steerYaw)
    goal.quaternion.multiply(this.turn)

    // A faint wobble that grows with the square of speed.
    const amount = cfg.shake * speed * speed

    if (amount > 0) {
      const t = this.time

      const pitch =
        (Math.sin(t * 31.7) +
          0.6 * Math.sin(t * 47.3 + 1.3)) *
        SHAKE_ROTATION *
        amount

      const roll =
        Math.sin(t * 27.1 + 0.7) *
        SHAKE_ROTATION *
        0.7 *
        amount

      const lift =
        (Math.sin(t * 53.9 + 2.1) +
          0.5 * Math.sin(t * 19.3)) *
        SHAKE_LIFT *
        amount

      this.euler.set(pitch, 0, roll)
      this.turn.setFromEuler(this.euler)

      goal.quaternion.multiply(this.turn)

      this.offset
        .set(0, lift, 0)
        .applyQuaternion(goal.quaternion)

      goal.position.add(this.offset)
    }

    goal.fov =
      cfg.fovBase + (cfg.fovMax - cfg.fovBase) * speed

    goal.near = cfg.near
  }

  /** Mixes the old pose into the goal while a blend is running. */
  private blendAndApply(frameDt: number): void {
    const goal = this.goal
    const shown = this.shown

    if (this.blend >= 1) {
      shown.position.copy(goal.position)
      shown.quaternion.copy(goal.quaternion)
      shown.fov = goal.fov
      shown.near = goal.near
    } else {
      this.blend = Math.min(
        1,
        this.blend + frameDt / BLEND_SECONDS,
      )

      const e = this.blend * this.blend * (3 - 2 * this.blend)

      // Bring the start pose back out of the car's space,
      // so it has moved along with the car.
      const car = this.target.object

      this.fromPosition.copy(this.from.position)
      car.localToWorld(this.fromPosition)

      this.fromQuaternion
        .copy(car.quaternion)
        .multiply(this.from.quaternion)

      shown.position.lerpVectors(
        this.fromPosition,
        goal.position,
        e,
      )

      shown.quaternion.slerpQuaternions(
        this.fromQuaternion,
        goal.quaternion,
        e,
      )

      shown.fov = THREE.MathUtils.lerp(
        this.from.fov,
        goal.fov,
        e,
      )

      // Smoothly transition the near clipping plane between camera views.
      shown.near = THREE.MathUtils.lerp(
        this.from.near,
        goal.near,
        e,
      )
    }

    // Apply the resulting pose to the camera.
    const camera = this.camera

    camera.position.copy(shown.position)
    camera.quaternion.copy(shown.quaternion)

    let projectionChanged = false

    if (Math.abs(camera.fov - shown.fov) > 0.01) {
      camera.fov = shown.fov
      projectionChanged = true
    }

    if (Math.abs(camera.near - shown.near) > 0.0001) {
      camera.near = shown.near
      projectionChanged = true
    }

    if (projectionChanged) {
      camera.updateProjectionMatrix()
    }
  }
}
