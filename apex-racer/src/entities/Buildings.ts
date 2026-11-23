import * as THREE from 'three'
import {
  FACADE_NAMES,
  uPerMetre,
  vPerMetre,
  type FacadeName,
  type FacadeStyle,
} from '@/entities/FacadeTextures'
import type { TrackSpace } from '@/systems/TrackSpace'

type Styles = Record<FacadeName, FacadeStyle>
type Vec3 = readonly [number, number, number]
type Random = () => number

/** A busy area: buildings are densest at `along` (metres from the start line) and thin out over `radius`. */
export interface DensityCluster {
  along: number
  radius: number
  strength: number // 0..1: the density at the centre of the cluster
}

export interface BuildingsOptions {
  seed?: number
  /** 0..1: the share of the planned buildings to show. Can be changed later with setDensity(). */
  density?: number
  /** 0..1: how built-up the quietest stretches are. */
  baseDensity?: number
  clusters?: readonly DensityCluster[]
}

const GROUND_Y = -0.15 // walls start just below the grass (at -0.1), so no gap shows at the base
const ROAD_MARGIN = 8 // metres a building keeps from every barrier, including other stretches of road
const BUILDING_GAP = 3 // metres kept between buildings
const MAX_BUILDING_RADIUS = 16 // larger than any building's half-diagonal; sizes the neighbour search
const HASH_CELL = 40 // metres: the size of one cell of the placement grid

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** A small seeded random generator, so the city comes out the same on every load. */
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

// ---------------------------------------------------------------------------
// Planning: where the buildings go
// ---------------------------------------------------------------------------

/** A rectangle on the ground. Local x runs along the building's width, and local z across its depth. */
export interface Plot {
  cx: number
  cz: number
  hw: number // half width
  hd: number // half depth
  rot: number // turn about the vertical axis, the same as Object3D.rotation.y
  radius: number
}

interface Building extends Plot {
  style: FacadeName
  height: number
  tint: Vec3 // a slight brightness and colour variation, multiplied into the wall texture
  uShift: number // texture offset across the wall, in whole tiles quarters, so neighbours differ
  vShift: number
  rooftop: { x: number; z: number; hw: number; hd: number; h: number } | null
  rank: number // 0..1: shown while this is below the density setting
}

/** True when two rectangles are closer than `gap` metres, or overlap. Uses the separating-axis test. */
function rectsOverlap(a: Plot, b: Plot, gap: number): boolean {
  const ca = Math.cos(a.rot)
  const sa = Math.sin(a.rot)
  const cb = Math.cos(b.rot)
  const sb = Math.sin(b.rot)
  const dx = b.cx - a.cx
  const dz = b.cz - a.cz
  // The four candidate axes are the two edge directions of each rectangle.
  const axes: readonly (readonly [number, number])[] = [
    [ca, -sa],
    [sa, ca],
    [cb, -sb],
    [sb, cb],
  ]
  for (const [nx, nz] of axes) {
    const ra = a.hw * Math.abs(nx * ca - nz * sa) + a.hd * Math.abs(nx * sa + nz * ca)
    const rb = b.hw * Math.abs(nx * cb - nz * sb) + b.hd * Math.abs(nx * sb + nz * cb)
    if (Math.abs(dx * nx + dz * nz) >= ra + rb + gap) return false // a gap on this axis: they don't touch
  }
  return true
}

/** Remembers the plots already placed, so a new one is only compared with its neighbours. */
class PlotGrid {
  private readonly cells = new Map<number, Plot[]>()

  add(p: Plot): void {
    const key = this.key(Math.floor(p.cx / HASH_CELL), Math.floor(p.cz / HASH_CELL))
    const list = this.cells.get(key)
    if (list) list.push(p)
    else this.cells.set(key, [p])
  }

  overlaps(p: Plot, gap: number): boolean {
    const reach = p.radius + MAX_BUILDING_RADIUS + gap
    const x0 = Math.floor((p.cx - reach) / HASH_CELL)
    const x1 = Math.floor((p.cx + reach) / HASH_CELL)
    const z0 = Math.floor((p.cz - reach) / HASH_CELL)
    const z1 = Math.floor((p.cz + reach) / HASH_CELL)
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.cells.get(this.key(ix, iz))
        if (!list) continue
        for (const q of list) if (rectsOverlap(p, q, gap)) return true
      }
    }
    return false
  }

  private key(ix: number, iz: number): number {
    return (ix + 2048) * 4096 + (iz + 2048)
  }
}

interface Row {
  near: number // metres between the barrier's outer face and this row's nearest wall
  chance: (density: number) => number // the chance a plot is built, from the local density (0.2 to 1)
  floorsSparse: readonly [number, number] // the range of floors in a quiet area
  floorsDense: readonly [number, number] // the range of floors in a busy area
  maxBays: number // the most bays a building in this row is wide
}

const ROWS: readonly Row[] = [
  { near: 12, chance: (d) => 0.25 + 0.7 * d, floorsSparse: [2, 4], floorsDense: [3, 7], maxBays: 6 },
  { near: 42, chance: (d) => 1.2 * d - 0.3, floorsSparse: [3, 6], floorsDense: [6, 14], maxBays: 5 },
  { near: 80, chance: (d) => 1.4 * d - 0.7, floorsSparse: [8, 12], floorsDense: [12, 22], maxBays: 5 },
]

/** Picks a wall style. Busy areas lean toward glass and concrete, quiet ones toward brick and stucco. */
function pickStyle(rand: Random, styles: Styles, busy: number, tall: boolean): FacadeStyle {
  const homely = tall ? 0.15 : 1 // a tall building is never brick or stucco, in practice
  const weights: Record<FacadeName, number> = {
    glass: 0.15 + 3 * busy * busy,
    concrete: 0.5 + 1.5 * busy,
    brick: (0.7 + 2 * (1 - busy)) * homely,
    stucco: (0.7 + 2 * (1 - busy)) * homely,
  }
  let total = 0
  for (const name of FACADE_NAMES) total += weights[name]
  let pick = rand() * total
  for (const name of FACADE_NAMES) {
    pick -= weights[name]
    if (pick <= 0) return styles[name]
  }
  return styles.concrete
}

function planBuildings(
  space: TrackSpace,
  styles: Styles,
  seed: number,
  clusters: readonly DensityCluster[],
  base: number,
): Building[] {
  const rand = mulberry32(seed)
  const track = space.track
  const length = track.length
  const grid = new PlotGrid()
  const plan: Building[] = []

  /** How built-up the track is at a distance along it: the base level, or the strongest cluster nearby. */
  const densityAt = (s: number): number => {
    let d = base
    for (const c of clusters) {
      let delta = Math.abs(s - c.along) % length
      delta = Math.min(delta, length - delta) // the loop wraps round at the start line
      const t = clamp01((delta / c.radius - 0.3) / 0.7) // flat in the middle 30%, then falling away
      d = Math.max(d, c.strength * (1 - t * t * (3 - 2 * t)))
    }
    return d
  }

  for (const row of ROWS) {
    for (const side of [-1, 1]) {
      let s = rand() * 12
      while (s < length) {
        const d = densityAt(s)
        if (rand() >= clamp01(row.chance(d))) {
          s += 8 + rand() * 14 // leave a gap
          continue
        }

        const busy = clamp01((d - base) / Math.max(1 - base, 1e-3))
        const lo = Math.round(lerp(row.floorsSparse[0], row.floorsDense[0], busy))
        const hi = Math.round(lerp(row.floorsSparse[1], row.floorsDense[1], busy))
        const floors = lo + Math.floor(Math.pow(rand(), 1.4) * (hi - lo + 1))
        const tall = floors >= 10

        const style = pickStyle(rand, styles, busy, tall)
        const bay = style.bayWidth
        const alongBays = Math.min(2 + Math.floor(rand() * (row.maxBays - 1)), tall ? 5 : row.maxBays)
        const depthBays = Math.max(2 + Math.floor(rand() * 3), tall ? 3 : 2)
        const width = alongBays * bay
        const depth = depthBays * bay

        // The building's middle sits on the track at the middle of its width, set back from the road.
        const mid = (s + width / 2) % length
        const sample = track.sampleAt(Math.round(mid / track.spacing))
        const lateral = space.outerEdge + row.near + depth / 2
        const plot: Plot = {
          cx: sample.position.x + sample.right.x * side * lateral,
          cz: sample.position.z + sample.right.z * side * lateral,
          hw: width / 2,
          hd: depth / 2,
          // Local x along the road, so local z points to the right of travel, like the track's own axes.
          rot: Math.atan2(-sample.tangent.z, sample.tangent.x),
          radius: Math.hypot(width / 2, depth / 2),
        }

        if (!space.footprintClear(plot.cx, plot.cz, plot.hw, plot.hd, plot.rot, ROAD_MARGIN) || grid.overlaps(plot, BUILDING_GAP)) {
          s += 6 + rand() * 8 // blocked by the road or a neighbour: try a bit further on
          continue
        }
        grid.add(plot)

        const brightness = 0.88 + rand() * 0.12
        const tint: Vec3 = [
          brightness * (0.97 + rand() * 0.06),
          brightness * (0.97 + rand() * 0.06),
          brightness * (0.97 + rand() * 0.06),
        ]
        let rooftop: Building['rooftop'] = null
        if (width > 8 && rand() < 0.3) {
          const rhw = plot.hw * (0.18 + rand() * 0.2)
          const rhd = plot.hd * (0.18 + rand() * 0.2)
          rooftop = {
            x: (rand() * 2 - 1) * (plot.hw - rhw - 0.5),
            z: (rand() * 2 - 1) * (plot.hd - rhd - 0.5),
            hw: rhw,
            hd: rhd,
            h: 1.5 + rand() * 2.5,
          }
        }
        plan.push({
          ...plot,
          style: style.name,
          height: floors * style.floorHeight,
          tint,
          uShift: Math.floor(rand() * 4) / 4,
          vShift: Math.floor(rand() * 4) / 4,
          rooftop,
          rank: rand(),
        })
        s += width + 3 + rand() * 6
      }
    }
  }
  return plan
}

// ---------------------------------------------------------------------------
// Building the meshes
// ---------------------------------------------------------------------------

/** Collects the quads of many buildings, then turns them into one geometry. */
class Soup {
  readonly positions: number[] = []
  readonly normals: number[] = []
  readonly uvs: number[] = []
  readonly colors: number[] = []
  readonly indices: number[] = []

  /** Adds one flat quad. The corners must run anticlockwise as seen from outside, with the normal pointing out. */
  quad(
    corners: readonly Vec3[],
    nx: number,
    ny: number,
    nz: number,
    uvs: readonly (readonly [number, number])[],
    colors: readonly Vec3[],
  ): void {
    const first = this.positions.length / 3
    for (let i = 0; i < 4; i++) {
      const p = corners[i]!
      const uv = uvs[i]!
      const c = colors[i]!
      this.positions.push(p[0], p[1], p[2])
      this.normals.push(nx, ny, nz)
      this.uvs.push(uv[0], uv[1])
      this.colors.push(c[0], c[1], c[2])
    }
    this.indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
  }

  toGeometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3))
    geometry.setIndex(new THREE.Uint32BufferAttribute(this.indices, 1))
    geometry.computeBoundingSphere()
    return geometry
  }
}

/** A box: four walls and a roof, with no bottom. Positions are in the building's own space. */
interface Prism {
  x: number
  z: number
  hw: number
  hd: number
  y0: number
  y1: number
  textured: boolean // false: every face uses the plain roof colour from the texture
  shade: number // a brightness multiplier
}

function addPrism(soup: Soup, b: Building, style: FacadeStyle, p: Prism): void {
  const c = Math.cos(b.rot)
  const s = Math.sin(b.rot)
  // The building's own axes in the world: local x is (c, -s) and local z is (s, c).
  const point = (lx: number, y: number, lz: number): Vec3 => [b.cx + c * lx + s * lz, y, b.cz - s * lx + c * lz]

  const top: Vec3 = [b.tint[0] * p.shade, b.tint[1] * p.shade, b.tint[2] * p.shade]
  const bottom: Vec3 = [top[0] * 0.72, top[1] * 0.72, top[2] * 0.72] // darker at the base, a cheap stand-in for shadow
  const roof: Vec3 = [top[0] * 0.55, top[1] * 0.55, top[2] * 0.55]
  const du = uPerMetre(style)
  const dv = vPerMetre(style)
  const [ru, rv] = style.roofUV
  const wallHeight = p.y1 - p.y0
  const { hw, hd } = p

  // Each face is described by its bottom-left and bottom-right corners as seen from outside, and its normal.
  const faces = [
    { ax: hw, az: hd, bx: hw, bz: -hd, nx: 1, nz: 0, width: 2 * hd },
    { ax: -hw, az: -hd, bx: -hw, bz: hd, nx: -1, nz: 0, width: 2 * hd },
    { ax: -hw, az: hd, bx: hw, bz: hd, nx: 0, nz: 1, width: 2 * hw },
    { ax: hw, az: -hd, bx: -hw, bz: -hd, nx: 0, nz: -1, width: 2 * hw },
  ]
  faces.forEach((f, i) => {
    const u0 = b.uShift + i * 0.25 // each face starts at a different part of the texture
    const u1 = u0 + f.width * du
    const v0 = b.vShift
    const v1 = v0 + wallHeight * dv
    const uv: readonly (readonly [number, number])[] = p.textured
      ? [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]
      : [[ru, rv], [ru, rv], [ru, rv], [ru, rv]]
    soup.quad(
      [
        point(p.x + f.ax, p.y0, p.z + f.az),
        point(p.x + f.bx, p.y0, p.z + f.bz),
        point(p.x + f.bx, p.y1, p.z + f.bz),
        point(p.x + f.ax, p.y1, p.z + f.az),
      ],
      c * f.nx + s * f.nz,
      0,
      -s * f.nx + c * f.nz,
      uv,
      [bottom, bottom, top, top],
    )
  })

  // The roof is mapped to one plain spot in the texture, so it is a solid colour, not a grid of windows.
  soup.quad(
    [
      point(p.x - hw, p.y1, p.z + hd),
      point(p.x + hw, p.y1, p.z + hd),
      point(p.x + hw, p.y1, p.z - hd),
      point(p.x - hw, p.y1, p.z - hd),
    ],
    0,
    1,
    0,
    [[ru, rv], [ru, rv], [ru, rv], [ru, rv]],
    [roof, roof, roof, roof],
  )
}

function addBuilding(soup: Soup, b: Building, style: FacadeStyle): void {
  addPrism(soup, b, style, { x: 0, z: 0, hw: b.hw, hd: b.hd, y0: GROUND_Y, y1: b.height, textured: true, shade: 1 })
  if (b.rooftop) {
    const r = b.rooftop
    addPrism(soup, b, style, { x: r.x, z: r.z, hw: r.hw, hd: r.hd, y0: b.height, y1: b.height + r.h, textured: false, shade: 0.85 })
  }
}

export class Buildings {
  /** Add this to the scene. */
  readonly object = new THREE.Group()
  /** How many buildings were planned. setDensity(1) shows all of them. */
  readonly total: number

  private readonly styles: Styles
  private readonly plan: readonly Building[]
  private readonly meshes: Record<FacadeName, THREE.Mesh>
  private shown = 0

  /**
   * Plans the city once, then builds one mesh per wall style. The textures belong to `styles`, which
   * the caller makes with createFacadeStyles() and frees with disposeFacadeStyles().
   */
  constructor(space: TrackSpace, styles: Styles, options: BuildingsOptions = {}) {
    this.styles = styles
    const base = clamp01(options.baseDensity ?? 0.2)
    const length = space.track.length
    const clusters: readonly DensityCluster[] = options.clusters ?? [
      { along: 0, radius: 520, strength: 1 }, // around the start straight
      { along: length * 0.55, radius: 320, strength: 0.65 }, // a smaller town further round
    ]
    this.plan = planBuildings(space, styles, options.seed ?? 7, clusters, base)
    this.total = this.plan.length

    const meshes = {} as Record<FacadeName, THREE.Mesh>
    for (const name of FACADE_NAMES) {
      // Plain, cheap lighting: no normal maps, no shadows cast or received.
      const material = new THREE.MeshLambertMaterial({ map: styles[name].texture, vertexColors: true })
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
      mesh.name = `buildings-${name}`
      this.object.add(mesh)
      meshes[name] = mesh
    }
    this.meshes = meshes
    this.setDensity(options.density ?? 1)
  }

  /** How many buildings are showing at the moment. */
  get visibleCount(): number {
    return this.shown
  }

    /** Where every planned building stands, whether or not it is currently shown. Used to keep trees clear of them. */
  get footprints(): readonly Plot[] {
    return this.plan
  }
  
  /**
   * Shows a share of the planned buildings, from 0 (none) to 1 (all). Buildings never move: a lower
   * setting only hides some of them, so quality changes don't rearrange the city. The meshes are
   * rebuilt, which takes a few milliseconds.
   */
  setDensity(density: number): void {
    const limit = clamp01(density)
    let shown = 0
    for (const name of FACADE_NAMES) {
      const soup = new Soup()
      const style = this.styles[name]
      for (const b of this.plan) {
        if (b.style !== name || b.rank >= limit) continue
        addBuilding(soup, b, style)
        shown++
      }
      const mesh = this.meshes[name]
      mesh.geometry.dispose()
      mesh.geometry = soup.toGeometry()
      mesh.visible = soup.indices.length > 0
    }
    this.shown = shown
  }

  dispose(): void {
    for (const name of FACADE_NAMES) {
      const mesh = this.meshes[name]
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.object.removeFromParent()
  }
}