import * as THREE from 'three'
import type { TrackSpace } from '@/systems/TrackSpace'

type Vec3 = readonly [number, number, number]
type Random = () => number

/** A rectangle on the ground: its centre, half sizes, and its turn about the vertical axis (the same as Object3D.rotation.y). */
export interface Footprint {
  cx: number
  cz: number
  hw: number
  hd: number
  rot: number
}

export interface PropsOptions {
  seed?: number
  /** 0..1: the share of the planned trees to show. Can be changed later with setTreeDensity(). */
  treeDensity?: number
  /** The most trees planned. */
  maxTrees?: number
  /** Metres between street lamps along each side of the track. */
  lampSpacing?: number
  grandstand?: boolean
  /** Where the grandstand's middle is, in metres along the track from the start line. */
  standAlong?: number
  /** 1 puts it on the right of the direction of travel, -1 on the left. */
  standSide?: 1 | -1
}

const UP = new THREE.Vector3(0, 1, 0)
const GROUND_Y = -0.15 // just below the grass (at -0.1), so nothing seems to float
const LAMP_SPACING = 55 // metres
const LAMP_GAP = 1.2 // metres beyond the barrier's outer face where a lamp stands
const TREE_STRIP_NEAR = 3 // metres beyond the barrier where the strip of trees starts
const TREE_STRIP_WIDTH = 7 // metres
const TREE_ROAD_GAP = 3 // a tree keeps at least this far from every barrier
const CLUMP_NEAR = 22 // clumps of trees stand between this far and CLUMP_FAR beyond the barriers
const CLUMP_FAR = 150
const MAX_TREES = 360

const STAND = {
  width: 48, // metres along the track
  tiers: 5,
  tierDepth: 1.4, // metres of each step, front to back
  tierHeight: 0.55, // metres each step rises
  setback: 2, // metres beyond the barrier where the front of the stand begins
  roofFront: -1.2, // the roof reaches this far in front of the first tier
  roofBack: 1.0, // and this far behind the last one
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** A small seeded random generator, so the scenery comes out the same on every load. */
function mulberry32(seed: number): Random {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** True when the point (x, z) is within `r` metres of any of the rectangles. */
function nearRect(rects: readonly Footprint[], x: number, z: number, r: number): boolean {
  for (const f of rects) {
    const dx = x - f.cx
    const dz = z - f.cz
    const c = Math.cos(f.rot)
    const s = Math.sin(f.rot)
    // The point in the rectangle's own space: the inverse of world = (c*lx + s*lz, -s*lx + c*lz).
    const lx = c * dx - s * dz
    const lz = s * dx + c * dz
    const qx = Math.max(Math.abs(lx) - f.hw, 0)
    const qz = Math.max(Math.abs(lz) - f.hd, 0)
    if (qx * qx + qz * qz < r * r) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Shapes: small meshes drawn once, then stamped many times into one big geometry
// ---------------------------------------------------------------------------

interface Part {
  geometry: THREE.BufferGeometry
  matrix: THREE.Matrix4
  color: Vec3
}

/** A shape made of flat-coloured parts, as plain arrays of triangles (three vertices each, no index). */
interface Template {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  count: number // vertices
}

function part(geometry: THREE.BufferGeometry, x: number, y: number, z: number, color: Vec3): Part {
  return { geometry, matrix: new THREE.Matrix4().makeTranslation(x, y, z), color }
}

function makeTemplate(parts: readonly Part[]): Template {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  for (const p of parts) {
    const g = p.geometry.clone().applyMatrix4(p.matrix).toNonIndexed()
    const position = g.getAttribute('position')
    const normal = g.getAttribute('normal')
    for (let i = 0; i < position.count; i++) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i))
      normals.push(normal.getX(i), normal.getY(i), normal.getZ(i))
      colors.push(p.color[0], p.color[1], p.color[2])
    }
    g.dispose()
    p.geometry.dispose()
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    count: positions.length / 3,
  }
}

const BROWN: Vec3 = [0.34, 0.24, 0.15]

function pineTemplate(): Template {
  return makeTemplate([
    part(new THREE.BoxGeometry(0.35, 1.6, 0.35), 0, 0.8, 0, BROWN),
    part(new THREE.ConeGeometry(1.6, 2.6, 7), 0, 2.9, 0, [0.2, 0.42, 0.18]),
    part(new THREE.ConeGeometry(1.15, 2.2, 7), 0, 4.4, 0, [0.17, 0.38, 0.16]),
  ])
}

function roundTreeTemplate(): Template {
  return makeTemplate([
    part(new THREE.BoxGeometry(0.4, 2.0, 0.4), 0, 1.0, 0, BROWN),
    part(new THREE.IcosahedronGeometry(1.7, 0), 0, 3.4, 0, [0.28, 0.5, 0.2]),
  ])
}

/** A street lamp. Its base is the origin and its arm reaches toward -z, which the stamp turns toward the road. */
function lampTemplate(): Template {
  const metal: Vec3 = [0.36, 0.38, 0.4]
  const lamp: Vec3 = [0.92, 0.9, 0.78]
  return makeTemplate([
    part(new THREE.BoxGeometry(0.22, 7, 0.22), 0, 3.5, 0, metal),
    part(new THREE.BoxGeometry(0.14, 0.14, 2.7), 0, 7.0, -1.25, metal),
    part(new THREE.BoxGeometry(0.5, 0.16, 1.1), 0, 6.9, -2.7, lamp),
  ])
}

/**
 * The grandstand. Local x runs along the track, y is up, and z points away from the road. Its front
 * edge is at z = 0, and the tiers rise toward +z.
 */
function standTemplate(): Template {
  const { width: W, tiers, tierDepth: D, tierHeight: H } = STAND
  const concrete: Vec3 = [0.62, 0.62, 0.6]
  const red: Vec3 = [0.78, 0.12, 0.14]
  const blue: Vec3 = [0.14, 0.3, 0.7]
  const parts: Part[] = []

  for (let k = 0; k < tiers; k++) {
    const h = (k + 1) * H
    const z = (k + 0.5) * D
    parts.push(part(new THREE.BoxGeometry(W, h, D), 0, h / 2, z, concrete))
    // Seat blocks in sections along the front half of each step, alternating red and blue.
    const sections = 6
    const sectionWidth = W / sections
    for (let n = 0; n < sections; n++) {
      const x = -W / 2 + (n + 0.5) * sectionWidth
      parts.push(
        part(new THREE.BoxGeometry(sectionWidth - 0.6, 0.12, D * 0.5), x, h + 0.06, z - D * 0.15, (n + k) % 2 === 0 ? red : blue),
      )
    }
  }

  const back = tiers * D
  const wallHeight = tiers * H + 2.8
  parts.push(part(new THREE.BoxGeometry(W, wallHeight, 0.4), 0, wallHeight / 2, back + 0.2, [0.5, 0.5, 0.5]))

  const roofY = 6.2
  const roofDepth = back + STAND.roofBack - STAND.roofFront
  const roofZ = STAND.roofFront + roofDepth / 2
  parts.push(part(new THREE.BoxGeometry(W + 2, 0.35, roofDepth), 0, roofY, roofZ, [0.8, 0.14, 0.14]))
  for (let x = -W / 2 + 1; x <= W / 2 - 1 + 0.01; x += (W - 2) / 6) {
    parts.push(part(new THREE.BoxGeometry(0.4, roofY, 0.4), x, roofY / 2, back + 0.6, [0.4, 0.4, 0.42]))
  }
  return makeTemplate(parts)
}

/** Copies templates, moved and scaled, into one big set of triangles. */
class Stamper {
  private readonly positions: number[] = []
  private readonly normals: number[] = []
  private readonly colors: number[] = []
  private readonly v = new THREE.Vector3()
  private readonly n = new THREE.Vector3()
  private readonly normalMatrix = new THREE.Matrix3()

  stamp(t: Template, m: THREE.Matrix4, tint: Vec3 = [1, 1, 1]): void {
    this.normalMatrix.getNormalMatrix(m)
    for (let i = 0; i < t.count; i++) {
      this.v.set(t.positions[i * 3]!, t.positions[i * 3 + 1]!, t.positions[i * 3 + 2]!).applyMatrix4(m)
      this.n.set(t.normals[i * 3]!, t.normals[i * 3 + 1]!, t.normals[i * 3 + 2]!).applyMatrix3(this.normalMatrix).normalize()
      this.positions.push(this.v.x, this.v.y, this.v.z)
      this.normals.push(this.n.x, this.n.y, this.n.z)
      this.colors.push(t.colors[i * 3]! * tint[0], t.colors[i * 3 + 1]! * tint[1], t.colors[i * 3 + 2]! * tint[2])
    }
  }

  toGeometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3))
    if (this.positions.length > 0) geometry.computeBoundingSphere()
    return geometry
  }
}

// ---------------------------------------------------------------------------

interface Tree {
  x: number
  z: number
  scale: number
  rot: number
  kind: 0 | 1 // 0 is a pine, 1 is a round tree
  tint: Vec3
  rank: number // 0..1: shown while this is below the density setting
}

export class Props {
  /** Add this to the scene. */
  readonly object = new THREE.Group()
  /** How many trees were planned. setTreeDensity(1) shows all of them. */
  readonly treeTotal: number
  /** How many street lamps were placed. */
  readonly lampCount: number
  /** False when there was no room for the grandstand. */
  readonly hasGrandstand: boolean

  private readonly trees: readonly Tree[]
  private readonly treeTemplates: readonly [Template, Template]
  private readonly treeMesh: THREE.Mesh
  private readonly staticMesh: THREE.Mesh
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true })
  private shownTrees = 0

  /**
   * `buildings` are the planned building footprints (Buildings.footprints), which trees keep clear of.
   * Plans everything once, builds the fixed mesh (lamps and grandstand), and the tree mesh.
   */
  constructor(space: TrackSpace, buildings: readonly Footprint[], options: PropsOptions = {}) {
    const rand = mulberry32(options.seed ?? 11)
    const track = space.track
    const length = track.length
    const rects: Footprint[] = [...buildings]
    const fixed = new Stamper()
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const p = new THREE.Vector3()
    const one = new THREE.Vector3(1, 1, 1)

    // --- The grandstand -----------------------------------------------------
    let hasStand = false
    let standZone: { side: number; along: number; half: number } | null = null
    if (options.grandstand ?? true) {
      const side: number = options.standSide ?? 1
      const along = options.standAlong ?? 12
      const sample = track.sampleAt(Math.round(along / track.spacing))
      const rot = Math.atan2(-sample.tangent.z, sample.tangent.x) + (side < 0 ? Math.PI : 0) // local z points away from the road
      const front = space.outerEdge + STAND.setback
      const depth = STAND.tiers * STAND.tierDepth + STAND.roofBack - STAND.roofFront
      const centreDistance = front + STAND.roofFront + depth / 2
      const footprint: Footprint = {
        cx: sample.position.x + sample.right.x * side * centreDistance,
        cz: sample.position.z + sample.right.z * side * centreDistance,
        hw: STAND.width / 2 + 1,
        hd: depth / 2,
        rot,
      }
      // Its roof comes within a metre of the barrier, so the test margin is small.
      if (space.footprintClear(footprint.cx, footprint.cz, footprint.hw, footprint.hd, rot, 0.5)) {
        p.set(sample.position.x + sample.right.x * side * front, GROUND_Y, sample.position.z + sample.right.z * side * front)
        m.compose(p, q.setFromAxisAngle(UP, rot), one)
        fixed.stamp(standTemplate(), m)
        rects.push(footprint)
        hasStand = true
        standZone = { side, along, half: STAND.width / 2 + 4 }
      }
    }
    this.hasGrandstand = hasStand

    // --- Street lamps -------------------------------------------------------
    const lamp = lampTemplate()
    const spacing = options.lampSpacing ?? LAMP_SPACING
    let lamps = 0
    for (const side of [-1, 1]) {
      for (let s = 6 + (side < 0 ? spacing / 2 : 0); s < length; s += spacing) {
        if (standZone && side === standZone.side) {
          let d = Math.abs(s - standZone.along)
          d = Math.min(d, length - d) // the loop wraps round at the start line
          if (d < standZone.half) continue // under the grandstand's roof
        }
        const sample = track.sampleAt(Math.round(s / track.spacing))
        const offset = space.outerEdge + LAMP_GAP
        const x = sample.position.x + sample.right.x * side * offset
        const z = sample.position.z + sample.right.z * side * offset
        // Another stretch of road close by would make this lamp stand in the way; so would a building.
        if (space.clearance(x, z) < LAMP_GAP - 0.2 || nearRect(rects, x, z, 1.5)) continue
        const rot = Math.atan2(-sample.tangent.z, sample.tangent.x) + (side < 0 ? Math.PI : 0)
        p.set(x, GROUND_Y, z)
        m.compose(p, q.setFromAxisAngle(UP, rot), one)
        fixed.stamp(lamp, m)
        lamps++
      }
    }
    this.lampCount = lamps

    // --- Trees: planned here, built by setTreeDensity() ----------------------
    const trees: Tree[] = []
    const maxTrees = options.maxTrees ?? MAX_TREES
    const tryTree = (x: number, z: number): boolean => {
      if (trees.length >= maxTrees) return false
      if (space.clearance(x, z) < TREE_ROAD_GAP || nearRect(rects, x, z, 2.5)) return false
      trees.push({
        x,
        z,
        scale: 0.8 + rand() * 0.7,
        rot: rand() * Math.PI * 2,
        kind: rand() < 0.5 ? 0 : 1,
        tint: [0.85 + rand() * 0.3, 0.9 + rand() * 0.2, 0.85 + rand() * 0.25],
        rank: rand(),
      })
      return true
    }

    // A loose strip of trees just beyond the barriers, with gaps.
    for (const side of [-1, 1]) {
      for (let s = rand() * 20; s < length; s += 12 + rand() * 20) {
        if (rand() < 0.25) continue
        const sample = track.sampleAt(Math.round(s / track.spacing))
        const offset = space.outerEdge + TREE_STRIP_NEAR + rand() * TREE_STRIP_WIDTH
        tryTree(
          sample.position.x + sample.right.x * side * offset,
          sample.position.z + sample.right.z * side * offset,
        )
      }
    }

    // Small clumps out in the open grass, near enough to the road to be seen.
    const margin = CLUMP_FAR + 30
    for (let attempt = 0; attempt < 600 && trees.length < maxTrees; attempt++) {
      const cx = lerp(space.minX - margin, space.maxX + margin, rand())
      const cz = lerp(space.minZ - margin, space.maxZ + margin, rand())
      const clearance = space.clearance(cx, cz)
      if (clearance < CLUMP_NEAR || clearance > CLUMP_FAR || nearRect(rects, cx, cz, 12)) continue
      const count = 3 + Math.floor(rand() * 6)
      for (let i = 0; i < count; i++) {
        const angle = rand() * Math.PI * 2
        const radius = Math.sqrt(rand()) * 10
        tryTree(cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius)
      }
    }
    this.trees = trees
    this.treeTotal = trees.length
    this.treeTemplates = [pineTemplate(), roundTreeTemplate()]

    // --- The two meshes -----------------------------------------------------
    this.staticMesh = new THREE.Mesh(fixed.toGeometry(), this.material)
    this.staticMesh.name = 'props-fixed'
    this.treeMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    this.treeMesh.name = 'props-trees'
    this.object.add(this.staticMesh, this.treeMesh)
    this.setTreeDensity(options.treeDensity ?? 1)
  }

  /** How many trees are showing at the moment. */
  get visibleTrees(): number {
    return this.shownTrees
  }

  /**
   * Shows a share of the planned trees, from 0 (none) to 1 (all). Trees never move: a lower setting
   * only hides some of them. The tree mesh is rebuilt, which takes a few milliseconds.
   */
  setTreeDensity(density: number): void {
    const limit = clamp01(density)
    const stamper = new Stamper()
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()
    let shown = 0
    for (const t of this.trees) {
      if (t.rank >= limit) continue
      p.set(t.x, GROUND_Y, t.z)
      s.set(t.scale, t.scale, t.scale)
      m.compose(p, q.setFromAxisAngle(UP, t.rot), s)
      stamper.stamp(this.treeTemplates[t.kind]!, m, t.tint)
      shown++
    }
    this.treeMesh.geometry.dispose()
    this.treeMesh.geometry = stamper.toGeometry()
    this.treeMesh.visible = shown > 0
    this.shownTrees = shown
  }

  dispose(): void {
    this.staticMesh.geometry.dispose()
    this.treeMesh.geometry.dispose()
    this.material.dispose()
    this.object.removeFromParent()
  }
}