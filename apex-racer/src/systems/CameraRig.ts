import * as THREE from 'three'
import type { Car } from '@/entities/Car'

export interface CameraRigConfig {
  distance: number // metres behind the car at standstill
  extraDistance: number // additional metres pulled back at top speed
  height: number // metres above the ground
  lookAhead: number // metres in front of the car the camera aims at
  lookHeight: number // height of the aim point
  headingLag: number // 1/s, higher = camera swings behind the car faster
  fovBase: number // degrees at standstill
  fovMax: number // degrees at top speed
  fovResponse: number // 1/s, how quickly the FOV follows speed
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
}

/** Exponential smoothing factor that behaves the same at any frame rate. */
function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt)
}

/** Shortest signed difference between two angles, in -PI..PI. */
function angleDiff(target: number, current: number): number {
  const d = target - current
  return Math.atan2(Math.sin(d), Math.cos(d))
}

export class CameraRig {
  readonly config: CameraRigConfig

  private readonly camera: THREE.PerspectiveCamera
  private readonly target: Car
  private chaseHeading = 0
  private fov: number

  private readonly forward = new THREE.Vector3()
  private readonly aim = new THREE.Vector3()

  constructor(
    camera: THREE.PerspectiveCamera,
    target: Car,
    config: Partial<CameraRigConfig> = {},
  ) {
    this.camera = camera
    this.target = target
    this.config = { ...DEFAULT_CAMERA_CONFIG, ...config }
    this.fov = this.config.fovBase
    this.snap()
  }

  /** Call once per display frame, after the car's visual transform is updated. */
  update(frameDt: number): void {
    const cfg = this.config
    const car = this.target

    // Swing the chase heading toward the car's heading.
    const carHeading = car.object.rotation.y
    this.chaseHeading += angleDiff(carHeading, this.chaseHeading) * damp(cfg.headingLag, frameDt)

    const speedFraction = this.speedFraction()
    this.place(cfg.distance + cfg.extraDistance * speedFraction)

    // Field of view widens with speed. Only touch the projection when it changes.
    const targetFov = cfg.fovBase + (cfg.fovMax - cfg.fovBase) * speedFraction
    this.fov += (targetFov - this.fov) * damp(cfg.fovResponse, frameDt)
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov
      this.camera.updateProjectionMatrix()
    }
  }

  /** Jump straight to the ideal pose with no smoothing. Use after a reset. */
  snap(): void {
    this.chaseHeading = this.target.object.rotation.y
    this.fov = this.config.fovBase
    this.camera.fov = this.fov
    this.camera.updateProjectionMatrix()
    this.place(this.config.distance)
  }

  private speedFraction(): number {
    const car = this.target
    const fraction = car.velocity.length() / car.config.maxSpeed
    return Math.min(1, Math.max(0, fraction))
  }

  /** Positions the camera behind the car and aims it just ahead of the car. */
  private place(distance: number): void {
    const cfg = this.config
    const carPos = this.target.object.position

    // Unit vector the car "should" be facing, from the smoothed heading.
    this.forward.set(-Math.sin(this.chaseHeading), 0, -Math.cos(this.chaseHeading))

    this.camera.position
      .copy(carPos)
      .addScaledVector(this.forward, -distance)
      .setY(cfg.height)

    this.aim.copy(carPos).addScaledVector(this.forward, cfg.lookAhead).setY(cfg.lookHeight)
    this.camera.lookAt(this.aim)
  }
}