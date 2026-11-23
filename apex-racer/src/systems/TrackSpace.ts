import type { TrackData } from '@/entities/TrackData'

const CELL = 24 // metres: the size of one cell of the lookup grid
const BARRIER_THICKNESS = 0.5 // metres; matches Track.ts, so "clearance" is measured from the barrier's outer face
const TEST_STEP = 6 // metres between the test points laid across a footprint

/** The answer to "where is this point relative to the track?" */
export interface TrackProbe {
  distance: number // metres from the nearest point on the centre line
  lateral: number // sideways distance to that point: positive means right of the direction of travel
  index: number // the nearest centre-line sample
  along: number // metres along the track from the start line, to that nearest point
}

function makeProbe(): TrackProbe {
  return { distance: 0, lateral: 0, index: 0, along: 0 }
}

function cellKey(cx: number, cz: number): number {
  return (cx + 4096) * 8192 + (cz + 4096)
}

export class TrackSpace {
  readonly track: TrackData
  /** Distance from the centre line to the outer face of the barriers, in metres. */
  readonly outerEdge: number
  /** The box around the whole circuit's centre line. */
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number

  private readonly cells = new Map<number, number[]>() // grid cell -> the samples that start in it
  private readonly maxRing: number // how many rings of cells cover the whole circuit
  private readonly scratch = makeProbe() // reused by clearance(), so it makes no garbage
  private readonly found = { d2: 0, index: 0, t: 0 } // the best match of the probe in progress

  constructor(track: TrackData) {
    this.track = track
    this.outerEdge = track.wallOffset + BARRIER_THICKNESS

    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    track.samples.forEach((s, i) => {
      const { x, z } = s.position
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
      const key = cellKey(Math.floor(x / CELL), Math.floor(z / CELL))
      const list = this.cells.get(key)
      if (list) list.push(i)
      else this.cells.set(key, [i])
    })
    this.minX = minX
    this.maxX = maxX
    this.minZ = minZ
    this.maxZ = maxZ
    this.maxRing = Math.ceil(Math.max(maxX - minX, maxZ - minZ) / CELL) + 2
  }

  /**
   * Finds the nearest point on the track's centre line to (x, z), and says how far away it is, which
   * side of the road the point is on, and where along the track it is. It looks outward through the
   * grid and stops as soon as nothing closer can exist, so it is cheap even for a long circuit.
   * Pass `out` to reuse an object and avoid creating garbage.
   */
  probe(x: number, z: number, out: TrackProbe = makeProbe()): TrackProbe {
    const track = this.track
    const found = this.found
    found.d2 = Infinity
    found.index = 0
    found.t = 0

    const cx = Math.floor(x / CELL)
    const cz = Math.floor(z / CELL)
    const margin = track.spacing + 1 // a segment can start in a cell and reach into a nearer one

    for (let ring = 0; ring <= this.maxRing; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue // only the cells on this ring
          const list = this.cells.get(cellKey(cx + dx, cz + dz))
          if (list) for (const i of list) this.consider(i, x, z)
        }
      }
      // Everything not yet searched is at least this far away, so a closer match can't exist.
      const reach = ring * CELL - margin
      if (reach > 0 && found.d2 <= reach * reach) break
    }

    // A point far outside the circuit never reaches a sample through the rings, so check them all.
    if (found.d2 === Infinity) {
      for (let i = 0; i < track.samples.length; i++) this.consider(i, x, z)
    }

    const a = track.sampleAt(found.index)
    const b = track.sampleAt(found.index + 1)
    const px = a.position.x + (b.position.x - a.position.x) * found.t
    const pz = a.position.z + (b.position.z - a.position.z) * found.t
    out.distance = Math.sqrt(found.d2)
    out.lateral = (x - px) * a.right.x + (z - pz) * a.right.z
    out.index = found.index
    out.along = ((found.index + found.t) * track.spacing) % track.length
    return out
  }

  /**
   * Metres between (x, z) and the outer face of the nearest barrier. Zero or less means the point is
   * on the road or against the barrier. Larger means further away from every part of the circuit.
   */
  clearance(x: number, z: number): number {
    return this.probe(x, z, this.scratch).distance - this.outerEdge
  }

  /**
   * True when a rectangular footprint stays at least `margin` metres clear of the barriers everywhere.
   * `rotation` is the building's turn about the vertical axis, the same as Object3D.rotation.y.
   * Test points are laid across the whole footprint, not just the corners, so a long building can't
   * hide a stretch of road between its ends.
   */
  footprintClear(
    cx: number,
    cz: number,
    halfWidth: number,
    halfDepth: number,
    rotation: number,
    margin: number,
  ): boolean {
    const c = Math.cos(rotation)
    const s = Math.sin(rotation)
    // The footprint's own axes in the world: local x is (c, -s) and local z is (s, c).
    const nx = Math.max(1, Math.ceil((halfWidth * 2) / TEST_STEP))
    const nz = Math.max(1, Math.ceil((halfDepth * 2) / TEST_STEP))
    for (let i = 0; i <= nx; i++) {
      const u = -halfWidth + (2 * halfWidth * i) / nx
      for (let j = 0; j <= nz; j++) {
        const v = -halfDepth + (2 * halfDepth * j) / nz
        const x = cx + c * u + s * v
        const z = cz - s * u + c * v
        if (this.clearance(x, z) < margin) return false
      }
    }
    return true
  }

  /** Updates `found` if the segment from sample `i` to the next one passes closer to (x, z) than the best so far. */
  private consider(i: number, x: number, z: number): void {
    const a = this.track.sampleAt(i).position
    const b = this.track.sampleAt(i + 1).position
    const abx = b.x - a.x
    const abz = b.z - a.z
    const len2 = abx * abx + abz * abz
    let t = len2 > 0 ? ((x - a.x) * abx + (z - a.z) * abz) / len2 : 0
    t = Math.min(1, Math.max(0, t))
    const dx = x - (a.x + abx * t)
    const dz = z - (a.z + abz * t)
    const d2 = dx * dx + dz * dz
    if (d2 < this.found.d2) {
      this.found.d2 = d2
      this.found.index = i
      this.found.t = t
    }
  }
}