import * as THREE from 'three'

export interface TrackDefinition {
  name: string
  width: number // road width in metres
  points: ReadonlyArray<readonly [number, number]> // closed loop of (x, z) control points
}

export interface TrackSample {
  position: THREE.Vector3 // point on the centre line (y = 0)
  tangent: THREE.Vector3 // unit vector, direction of travel
  right: THREE.Vector3 // unit vector, pointing to the right of travel
  distance: number // metres from the start line along the track
}

export interface Pose {
  x: number
  z: number
  heading: number // same convention as Car.heading
}

/**
 * The first circuit. About 1.75 km, which is roughly a 50 second lap.
 * The start line is at the first point, and the start straight runs along -Z,
 * the same way the car faces at heading 0. Control points are about 100 m
 * apart, and the spline smooths between them. To make your own circuit, edit
 * these points. Keep them far apart relative to the road width, and the
 * console warning below will tell you if a corner is too tight.
 */
export const CIRCUIT_ONE: TrackDefinition = {
  name: 'Circuit One',
  width: 14,
  points: [
    [0, 100],
    [0, -60],
    [10, -200],
    [90, -280],
    [200, -300],
    [290, -240],
    [310, -140],
    [250, -60],
    [170, -10],
    [180, 70],
    [270, 140],
    [300, 240],
    [230, 320],
    [110, 330],
    [0, 260],
  ],
}

const UP = new THREE.Vector3(0, 1, 0)
export const BARRIER_MARGIN = 4 // metres beyond the road edge where the barrier goes
export class TrackData {
  readonly definition: TrackDefinition
  readonly width: number
  readonly halfWidth: number
  readonly length: number // total length of the centre line, metres
  readonly spacing: number // metres between consecutive samples
  readonly samples: TrackSample[] = []
  readonly minRadius: number // tightest corner on the centre line, metres

  constructor(definition: TrackDefinition, targetSpacing = 2) {
    this.definition = definition
    this.width = definition.width
    this.halfWidth = definition.width / 2

    const curve = new THREE.CatmullRomCurve3(
      definition.points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true, // closed
      'centripetal', // avoids loops and overshoot between control points
    )
    // The default (200) is too coarse for a track this long.
    curve.arcLengthDivisions = 4000

    this.length = curve.getLength()
    const count = Math.max(8, Math.round(this.length / targetSpacing))
    this.spacing = this.length / count

    for (let i = 0; i < count; i++) {
      const u = i / count // getPointAt and getTangentAt are by arc length
      const position = curve.getPointAt(u)
      position.y = 0
      const tangent = curve.getTangentAt(u)
      tangent.y = 0
      tangent.normalize()
      // Same convention as the car: right = forward x up.
      const right = new THREE.Vector3().crossVectors(tangent, UP)
      this.samples.push({ position, tangent, right, distance: i * this.spacing })
    }

    this.minRadius = this.computeMinRadius()
    if (this.minRadius < this.halfWidth + BARRIER_MARGIN) {
      console.warn(
        `[${definition.name}] tightest corner has a radius of ${this.minRadius.toFixed(1)} m, ` +
          `which is too tight for a ${definition.width} m road. ` +
          `The inside edge will fold over itself. Move some control points apart.`,
      )
    }
  }

  /** Sample by index. Wraps around, so -1 is the last sample and count is the first. */
  sampleAt(index: number): TrackSample {
    const n = this.samples.length
    return this.samples[((index % n) + n) % n]!
  }

  /** Position and heading on the centre line at a distance from the start line. */
  poseAt(distance: number): Pose {
    const index = Math.round(distance / this.spacing)
    const s = this.sampleAt(index)
    return {
      x: s.position.x,
      z: s.position.z,
      // Inverse of Car's forward vector (-sin h, -cos h).
      heading: Math.atan2(-s.tangent.x, -s.tangent.z),
    }
  }

  private computeMinRadius(): number {
    const n = this.samples.length
    let min = Infinity
    for (let i = 0; i < n; i++) {
      const a = this.sampleAt(i).tangent
      const b = this.sampleAt(i + 1).tangent
      const angle = Math.acos(Math.min(1, Math.max(-1, a.dot(b))))
      if (angle > 1e-6) min = Math.min(min, this.spacing / angle)
    }
    return min
  }
}