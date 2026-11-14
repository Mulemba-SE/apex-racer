
import * as THREE from 'three'
import { wheelsOf, type ModelWheel } from '@/entities/CarModel'
import type { Updatable } from '@/core/Game'
import type { Controls } from '@/core/Input'

export type CarViewPoint = 'hood' | 'cockpit'

export interface CarConfig {
  maxSpeed: number
  maxReverseSpeed: number
  acceleration: number
  brakeDecel: number
  coastDecel: number
  handbrakeDecel: number
  turnRate: number
  steerResponse: number
  steerReturn: number
  grip: number
  handbrakeGrip: number
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

/** Half the car's footprint in metres. */
export const CAR_HALF_WIDTH = 0.95
export const CAR_HALF_LENGTH = 2.1

export interface SurfaceModifiers {
  grip: number
  traction: number
  drag: number
}

export const ASPHALT: SurfaceModifiers = {
  grip: 1,
  traction: 1,
  drag: 0,
}

export const KERB: SurfaceModifiers = {
  grip: 0.85,
  traction: 0.9,
  drag: 0.05,
}

export const GRASS: SurfaceModifiers = {
  grip: 0.4,
  traction: 0.5,
  drag: 0.5,
}

const WHEEL_RADIUS = 0.35
const MAX_WHEEL_LOCK = 0.45
const MAX_YAW_KICK = 4
const YAW_KICK_DECAY = 5

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function moveToward(
  current: number,
  target: number,
  maxDelta: number,
): number {
  if (Math.abs(target - current) <= maxDelta) return target
  return current + Math.sign(target - current) * maxDelta
}

export class Car implements Updatable {
  /** Add this to the scene. Its transform is the car's visual transform. */
  readonly object = new THREE.Group()
  readonly config: CarConfig

  // Simulation state.
  readonly position = new THREE.Vector3()
  readonly velocity = new THREE.Vector3()
  heading = 0

  /** Surface currently under the car. */
  surface: SurfaceModifiers = ASPHALT

  private readonly controls: Controls
  private readonly body = new THREE.Group()
  private readonly wheels: THREE.Mesh[] = []
  private readonly frontPivots: THREE.Group[] = []
  private readonly wheelPivots: THREE.Group[] = []

  private customModel: THREE.Object3D | null = null
  private modelWheels: readonly ModelWheel[] = []

  private readonly forward = new THREE.Vector3()
  private readonly right = new THREE.Vector3()

  private steerValue = 0
  private roll = 0
  private yawKick = 0

  // Camera mounting points. These stay attached to the body when the GLB loads.
  readonly viewAnchors: Record<CarViewPoint, THREE.Object3D> = {
    hood: new THREE.Object3D(),
    cockpit: new THREE.Object3D(),
  }

  // Stores original visibility of meshes hidden by camera views.
  private readonly hiddenMeshes = new Map<THREE.Object3D, boolean>()

  // Previous step, kept for render interpolation.
  private readonly prevPosition = new THREE.Vector3()
  private prevHeading = 0

  constructor(
    controls: Controls,
    config: Partial<CarConfig> = {},
    paintColor = 0xd62828,
  ) {
    this.controls = controls
    this.config = { ...DEFAULT_CAR_CONFIG, ...config }

    this.buildModel(paintColor)

    // Attach camera mounts to the body so they follow its movement and roll.
    this.body.add(
      this.viewAnchors.hood,
      this.viewAnchors.cockpit,
    )

    // Initial positions for the normalized car model.
    this.viewAnchors.hood.position.set(0, 0.95, -1.35)
    this.viewAnchors.cockpit.position.set(0, 1.25, 0.15)

    this.interpolate(1)
  }

  /** Current speed in km/h. */
  get speedKmh(): number {
    return this.velocity.length() * 3.6
  }

  /** Smoothed steering input, from -1 (left) to 1 (right). */
  get steering(): number {
    return this.steerValue
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
      vf = moveToward(vf, 0, cfg.brakeDecel * dt)
    } else if (drive > 0) {
      if (vf < -0.5) {
        vf += cfg.brakeDecel * dt
      } else {
        const headroom = 1 - Math.max(vf, 0) / cfg.maxSpeed
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

    if (c.handbrake) {
      vf = moveToward(vf, 0, cfg.handbrakeDecel * dt)
    }

    // Surface drag.
    if (surface.drag > 0) {
      vf *= Math.exp(-surface.drag * dt)
    }

    // Sideways grip.
    const grip =
      (c.handbrake ? cfg.handbrakeGrip : cfg.grip) * surface.grip

    vl *= Math.exp(-grip * dt)

    // Smooth steering input.
    const building =
      c.steer !== 0 &&
      Math.sign(c.steer) === Math.sign(this.steerValue || c.steer)

    const steerRate = building
      ? cfg.steerResponse
      : cfg.steerReturn

    this.steerValue = moveToward(
      this.steerValue,
      c.steer,
      steerRate * dt,
    )

    // Steering authority depends on speed.
    const speed = Math.abs(vf)
    const lowSpeed = clamp(speed / 5, 0, 1)
    const highSpeed =
      1 - 0.5 * clamp(speed / cfg.maxSpeed, 0, 1)

    const authority =
      lowSpeed * highSpeed * (c.handbrake ? 1.3 : 1)

    const yawRate =
      this.steerValue *
      cfg.turnRate *
      authority *
      (vf >= 0 ? 1 : -1)

    // Recombine velocity with the old axes, then turn.
    this.velocity
      .copy(this.forward)
      .multiplyScalar(vf)
      .addScaledVector(this.right, vl)

    this.heading -= yawRate * dt
    this.heading += this.yawKick * dt

    this.yawKick *= Math.exp(-YAW_KICK_DECAY * dt)

    this.position.addScaledVector(this.velocity, dt)

    this.animate(dt, vf)
    this.interpolate(1)
  }

  /** Adds a short burst of spin from an impact. */
  kick(yawRate: number): void {
    this.yawKick = clamp(
      this.yawKick + yawRate,
      -MAX_YAW_KICK,
      MAX_YAW_KICK,
    )
  }

  /** Interpolates the visual transform between simulation steps. */
  interpolate(alpha: number): void {
    this.object.position.lerpVectors(
      this.prevPosition,
      this.position,
      alpha,
    )

    this.object.rotation.y = THREE.MathUtils.lerp(
      this.prevHeading,
      this.heading,
      alpha,
    )
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

  /**
   * Replaces the box-built body and wheels with a loaded GLB model.
   */
  setModel(model: THREE.Object3D): void {
    if (this.customModel) {
      this.customModel.removeFromParent()
    } else {
      this.disposeBoxParts()
    }

    model.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true
      }
    })

    this.body.add(model)

    this.customModel = model
    this.modelWheels = wheelsOf(model)
  }

  /**
   * Hides matching model parts for interior camera views.
   * Passing null restores their original visibility.
   * Only affects this car, not other cars sharing the same materials.
   */
  setHiddenMaterials(pattern: RegExp | null): void {
    // Restore meshes hidden by the previous camera view.
    for (const [mesh, original] of this.hiddenMeshes) {
      mesh.visible = original
    }

    this.hiddenMeshes.clear()

    if (!pattern) return

    const root = this.customModel ?? this.body

    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      if (Array.isArray(object.material)) return

      pattern.lastIndex = 0

      if (!pattern.test(object.material.name)) return

      this.hiddenMeshes.set(object, object.visible)
      object.visible = false
    })
  }

  /**
   * Frees the original box-built car parts without removing camera anchors.
   */
  private disposeBoxParts(): void {
    const cameraAnchors = new Set<THREE.Object3D>([
      this.viewAnchors.hood,
      this.viewAnchors.cockpit,
    ])

    // Preserve camera anchors while removing the procedural car body.
    const bodyParts = this.body.children.filter(
      (child) => !cameraAnchors.has(child),
    )

    const parts: THREE.Object3D[] = [
      ...bodyParts,
      ...this.wheelPivots,
    ]

    for (const part of parts) {
      part.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return

        o.geometry.dispose()

        const materials = Array.isArray(o.material)
          ? o.material
          : [o.material]

        for (const material of materials) {
          material.dispose()
        }
      })

      part.removeFromParent()
    }

    this.wheels.length = 0
    this.frontPivots.length = 0
    this.wheelPivots.length = 0
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

    for (const wheel of this.wheels) {
      wheel.rotation.x -= spin
    }

    for (const pivot of this.frontPivots) {
      pivot.rotation.y = -this.steerValue * MAX_WHEEL_LOCK
    }

    // Animate loaded model wheels.
    for (const w of this.modelWheels) {
      w.spin.rotation.x -= (forwardSpeed * dt) / w.radius

      if (w.front) {
        w.steer.rotation.y = -this.steerValue * MAX_WHEEL_LOCK
      }
    }

    const speedFraction = clamp(
      Math.abs(forwardSpeed) / this.config.maxSpeed,
      0,
      1,
    )

    const targetRoll =
      this.steerValue * speedFraction * 0.06

    this.roll +=
      (targetRoll - this.roll) * Math.min(1, 8 * dt)

    this.body.rotation.z = this.roll
  }

  private buildModel(paintColor: number): void {
    const paint = new THREE.MeshStandardMaterial({
      color: paintColor,
      roughness: 0.45,
      metalness: 0.3,
    })

    const glass = new THREE.MeshStandardMaterial({
      color: 0x1b2a3a,
      roughness: 0.2,
      metalness: 0.6,
    })

    const tyre = new THREE.MeshStandardMaterial({
      color: 0x151515,
      roughness: 0.9,
    })

    const rim = new THREE.MeshStandardMaterial({
      color: 0xbbbbbb,
      roughness: 0.4,
      metalness: 0.8,
    })

    const lamp = new THREE.MeshStandardMaterial({
      color: 0xfff2b0,
      emissive: 0xfff2b0,
      emissiveIntensity: 1.5,
    })

    const chassis = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.55, 4.2),
      paint,
    )

    chassis.position.y = 0.58

    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.5, 2.0),
      glass,
    )

    cabin.position.set(0, 1.1, 0.3)

    // Headlights mark the front (-Z).
    const lampGeo = new THREE.BoxGeometry(0.4, 0.15, 0.05)

    for (const x of [-0.65, 0.65]) {
      const l = new THREE.Mesh(lampGeo, lamp)
      l.position.set(x, 0.65, -2.1)
      this.body.add(l)
    }

    this.body.add(chassis, cabin)
    this.object.add(this.body)

    // Wheel geometry.
    const wheelGeo = new THREE.CylinderGeometry(
      WHEEL_RADIUS,
      WHEEL_RADIUS,
      0.3,
      20,
    )

    wheelGeo.rotateZ(Math.PI / 2)

    const hubGeo = new THREE.BoxGeometry(0.34, 0.1, 0.5)

    const layout = [
      { x: -1.0, z: -1.3, front: true },
      { x: 1.0, z: -1.3, front: true },
      { x: -1.0, z: 1.3, front: false },
      { x: 1.0, z: 1.3, front: false },
    ]

    for (const w of layout) {
      const pivot = new THREE.Group()

      pivot.position.set(w.x, WHEEL_RADIUS, w.z)

      const wheel = new THREE.Mesh(wheelGeo, tyre)

      wheel.add(new THREE.Mesh(hubGeo, rim))
      pivot.add(wheel)

      this.object.add(pivot)

      this.wheels.push(wheel)
      this.wheelPivots.push(pivot)

      if (w.front) {
        this.frontPivots.push(pivot)
      }
    }

    this.object.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true
      }
    })
  }
}
