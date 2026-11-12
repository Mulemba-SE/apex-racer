import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

export interface CarModelOptions {
  /** Where the .glb file is served from, e.g. '/models/car.glb' for public/models/car.glb. */
  url: string
  /** Length of the finished car in metres. The model is scaled to match, so its own units don't matter. */
  length?: number
  /**
   * Extra turn about the vertical axis, in radians. The default is Math.PI, because glTF models
   * normally face +Z and our car faces -Z. Use 0 for a model that already faces -Z, or
   * +-Math.PI / 2 for one that points along the x axis.
   */
  yaw?: number
  /** Recolour the body paint to this 0xRRGGBB colour. Leave it out to keep the model's own colours. */
  paintColor?: number
  /** Which materials count as "paint", matched against the material names. Defaults to /body|paint/i. */
  paintPattern?: RegExp
  /** Wheels are looked for first by node name: nodes matching this are wheel parts. */
  wheelPattern?: RegExp
  /** Nodes matching this are never treated as wheels (arches, brakes, steering wheel). */
  wheelExclude?: RegExp
  /**
   * If node names find nothing, wheels are looked for by material name: every mesh whose material
   * matches this is wheel geometry, and is split into four, one per corner of the car.
   */
  wheelMaterialPattern?: RegExp
  /** Materials matching this are never treated as wheel geometry. */
  wheelMaterialExclude?: RegExp
  /** Which of the wheel materials is the tyre. The tyre decides where each axle is. Defaults to /tyre|tire/i. */
  tyreMaterialPattern?: RegExp
}

/** One wheel, wrapped in two pivots at its centre. Car.animate() turns them. */
export interface ModelWheel {
  steer: THREE.Object3D // turns about the vertical axis; only moved for front wheels
  spin: THREE.Object3D // turns about its own x axis, which is aligned to the wheel's real axle
  front: boolean
  radius: number // metres
  axle: THREE.Vector3 // the wheel's real axle direction in the car's space; x is positive
}

/** Fraction from 0 to 1, or null when the server didn't say how big the file is. */
export type LoadProgress = (fraction: number | null) => void

const DEFAULT_LENGTH = 4.2
const DEFAULT_YAW = Math.PI
const DEFAULT_PAINT_PATTERN = /body|paint/i
const DEFAULT_WHEEL_PATTERN = /wheel|tyre|tire/i
const DEFAULT_WHEEL_EXCLUDE = /arch|well|house|guard|fender|brake|caliper|disc|steer/i
// "rim" and "disc" must start a word, so "trim" and "discount" don't match.
const DEFAULT_WHEEL_MATERIAL_PATTERN = /wheel|tyre|tire|(^|[^a-z])(rim|disc)/i
const DEFAULT_WHEEL_MATERIAL_EXCLUDE = /steer|caliper|arch/i
const DEFAULT_TYRE_MATERIAL_PATTERN = /tyre|tire/i
const MAX_WHEEL_FRACTION = 0.3 // a single wheel is never bigger than this share of the car's length
const WHEEL_REACH = 1.05 // wheel parts may reach this far beyond the tyre's radius
const WHEEL_WIDTH_SLACK = 0.1 // metres of extra width allowed beyond the tyre's sides
const CORNER_KEYS = ['LF', 'RF', 'LB', 'RB'] as const // left/right, front/back; the car faces -Z
const AXLE_X = new THREE.Vector3(1, 0, 0)

// The wheels of each model returned by create(), kept apart from the model itself so that
// create() can keep returning a plain group.
const rigs = new WeakMap<THREE.Object3D, ModelWheel[]>()

/** The wheels found in a model made by CarModelLoader.create(). Empty when none were found. */
export function wheelsOf(model: THREE.Object3D): readonly ModelWheel[] {
  return rigs.get(model) ?? []
}

/** A tyre measured from its geometry: where its axle is, which way it points, and how big it is. */
interface WheelFit {
  centre: THREE.Vector3
  axle: THREE.Vector3 // unit vector with a positive x
  radius: number
  halfWidth: number // along the axle
}

/** The parts of one wheel (a tyre and its rim, say), before they are put into pivots. */
interface WheelGroup {
  key: string // 'LF', 'RF', 'LB' or 'RB'
  parts: THREE.Object3D[]
  fit: WheelFit | null // null when the wheel was found by node name and has not been measured
}

/**
 * The eigenvector of a symmetric 3x3 matrix with the smallest eigenvalue, by Jacobi rotations.
 * For the covariance of a tyre's vertices that is the direction in which the tyre is thinnest,
 * which is its axle.
 */
function smallestEigenvector(matrix: number[][]): THREE.Vector3 {
  const a = matrix.map((row) => [...row])
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  for (let sweep = 0; sweep < 24; sweep++) {
    const off = Math.abs(a[0]![1]!) + Math.abs(a[0]![2]!) + Math.abs(a[1]![2]!)
    if (off < 1e-14) break
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p]![q]!
        if (Math.abs(apq) < 1e-18) continue
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < 3; k++) {
          const akp = a[k]![p]!
          const akq = a[k]![q]!
          a[k]![p] = c * akp - s * akq
          a[k]![q] = s * akp + c * akq
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p]![k]!
          const aqk = a[q]![k]!
          a[p]![k] = c * apk - s * aqk
          a[q]![k] = s * apk + c * aqk
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k]![p]!
          const vkq = v[k]![q]!
          v[k]![p] = c * vkp - s * vkq
          v[k]![q] = s * vkp + c * vkq
        }
      }
    }
  }
  let best = 0
  for (let i = 1; i < 3; i++) if (a[i]![i]! < a[best]![best]!) best = i
  return new THREE.Vector3(v[0]![best]!, v[1]![best]!, v[2]![best]!).normalize()
}

export class CarModelLoader {
  private readonly loader = new GLTFLoader()
  private readonly cache = new Map<string, Promise<THREE.Group>>()
  private readonly reported = new Set<string>()
  private strayTriangles = 0 // wheel-material triangles left on the body by the last create()

  /** Downloads and parses a model, once per URL. The result is the shared template: don't add it to a scene. */
  load(url: string, onProgress?: LoadProgress): Promise<THREE.Group> {
    let pending = this.cache.get(url)
    if (!pending) {
      pending = new Promise<THREE.Group>((resolve, reject) => {
        this.loader.load(
          url,
          (gltf) => {
            this.describe(url, gltf.scene)
            resolve(gltf.scene)
          },
          (event) => onProgress?.(event.lengthComputable ? event.loaded / event.total : null),
          (error) => reject(error instanceof Error ? error : new Error(`Could not load ${url}`)),
        )
      })
      this.cache.set(url, pending)
      pending.catch(() => this.cache.delete(url)) // a failed download isn't remembered, so it can be retried
    }
    return pending
  }

  /** A ready-to-use copy of the model: scaled, centred, facing -Z, optionally repainted, wheels rigged. */
  async create(options: CarModelOptions, onProgress?: LoadProgress): Promise<THREE.Group> {
    const template = await this.load(options.url, onProgress)
    const length = options.length ?? DEFAULT_LENGTH

    const model = template.clone(true) // shares geometry and materials with the template
    model.rotation.y = options.yaw ?? DEFAULT_YAW
    const root = new THREE.Group()
    root.add(model)

    // Scale so the length along z (the driving direction) is right.
    const box = new THREE.Box3()
    root.updateMatrixWorld(true)
    box.setFromObject(root)
    const size = box.getSize(new THREE.Vector3())
    model.scale.multiplyScalar(length / Math.max(size.z, 1e-3))

    // Centre it on the origin and put the lowest point (the tyres) on the ground.
    root.updateMatrixWorld(true)
    box.setFromObject(root)
    const centre = box.getCenter(new THREE.Vector3())
    model.position.x -= centre.x
    model.position.z -= centre.z
    model.position.y -= box.min.y

    this.applyPaint(model, options)

    root.updateMatrixWorld(true)
    this.strayTriangles = 0
    const { wheels, method } = this.rigWheels(root, options, length)
    rigs.set(root, wheels)
    this.report(options.url, root, wheels, method)
    return root
  }

  private applyPaint(model: THREE.Object3D, options: CarModelOptions): void {
    const paint = options.paintColor
    if (paint === undefined) return
    const pattern = options.paintPattern ?? DEFAULT_PAINT_PATTERN

    const tint = (material: THREE.Material): THREE.Material => {
      if (!pattern.test(material.name)) return material
      // Clone first: the original is shared with every other car made from this model.
      const copy = material.clone() as THREE.MeshStandardMaterial
      if (!copy.color) return material // this kind of material has no colour to change
      copy.color.setHex(paint)
      return copy
    }

    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      o.material = Array.isArray(o.material) ? o.material.map(tint) : tint(o.material)
    })
  }

  /**
   * Finds the wheels and wraps each in a steer pivot and a spin pivot. Wheels are looked for
   * by node name first, which is cheap and exact. If that doesn't find four, they are looked
   * for by material name instead, which also works when the model's meshes have been merged.
   */
  private rigWheels(
    root: THREE.Group,
    options: CarModelOptions,
    length: number,
  ): { wheels: ModelWheel[]; method: string } {
    const byName = this.groupsByName(root, options, length)
    if (byName.length === 4) return { wheels: this.buildPivots(root, byName), method: 'node names' }

    const byMaterial = this.groupsByMaterial(root, options)
    if (byMaterial.length > 0) {
      return { wheels: this.buildPivots(root, byMaterial), method: 'material names' }
    }

    const method = byName.length > 0 ? 'node names (incomplete)' : 'nothing'
    return { wheels: this.buildPivots(root, byName), method }
  }

  /** Wheel parts found by node name, grouped one group per corner of the car. */
  private groupsByName(root: THREE.Group, options: CarModelOptions, length: number): WheelGroup[] {
    const pattern = options.wheelPattern ?? DEFAULT_WHEEL_PATTERN
    const exclude = options.wheelExclude ?? DEFAULT_WHEEL_EXCLUDE
    const maxSize = length * MAX_WHEEL_FRACTION

    // The topmost matching node of each wheel part. A match that is too big to be one wheel
    // (a node called "Wheels" holding all four) is searched inside instead.
    const parts: THREE.Object3D[] = []
    const visit = (node: THREE.Object3D): void => {
      if (pattern.test(node.name) && !exclude.test(node.name)) {
        const box = new THREE.Box3().setFromObject(node)
        if (box.isEmpty()) return // nothing to draw in here
        const size = box.getSize(new THREE.Vector3())
        if (Math.max(size.x, size.y, size.z) <= maxSize) {
          parts.push(node)
          return // the node's children come with it
        }
      }
      for (const child of node.children) visit(child)
    }
    for (const child of root.children) visit(child)

    const groups = new Map<string, WheelGroup>()
    for (const part of parts) {
      const c = new THREE.Box3().setFromObject(part).getCenter(new THREE.Vector3())
      const key = `${c.x < 0 ? 'L' : 'R'}${c.z < 0 ? 'F' : 'B'}` // the car faces -Z, so negative z is the front
      const group = groups.get(key)
      if (group) group.parts.push(part)
      else groups.set(key, { key, parts: [part], fit: null })
    }
    return [...groups.values()]
  }

  /**
   * Wheel parts found by material name. Merged models keep all four tyres in one mesh, so the
   * triangles are sorted by wheel:
   *
   * 1. The tyre material's triangles are split by corner of the car, and each tyre is measured:
   *    its axle direction, centre and size are fitted to its vertices.
   * 2. Every triangle of every wheel material goes to the nearest tyre, if it lies inside that
   *    tyre's cylinder. Triangles outside any cylinder (other parts of the car that happen to
   *    share a rim or disc material) are left on the body, so they don't spin.
   *
   * Each wheel's triangles become a new mesh that shares the original's vertex data. Expects
   * `root` to be at the origin with an identity transform.
   */
  private groupsByMaterial(root: THREE.Group, options: CarModelOptions): WheelGroup[] {
    const include = options.wheelMaterialPattern ?? DEFAULT_WHEEL_MATERIAL_PATTERN
    const exclude = options.wheelMaterialExclude ?? DEFAULT_WHEEL_MATERIAL_EXCLUDE
    const tyreMaterial = options.tyreMaterialPattern ?? DEFAULT_TYRE_MATERIAL_PATTERN
    root.updateMatrixWorld(true)

    const sources: THREE.Mesh[] = []
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || (o as THREE.SkinnedMesh).isSkinnedMesh) return
      if (Array.isArray(o.material)) return
      const name = o.material.name
      if (include.test(name) && !exclude.test(name)) sources.push(o)
    })

    const a = new THREE.Vector3() // a triangle's corners in the mesh's own space
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    const aw = new THREE.Vector3() // the same corners in the car's space
    const bw = new THREE.Vector3()
    const cw = new THREE.Vector3()
    const mid = new THREE.Vector3()
    const offset = new THREE.Vector3()

    // Pass 1: gather each corner's tyre vertices, then measure each tyre.
    const tyrePoints: number[][] = CORNER_KEYS.map(() => [])
    for (const mesh of sources) {
      if (!tyreMaterial.test((mesh.material as THREE.Material).name)) continue
      const position = mesh.geometry.getAttribute('position')
      this.forEachTriangle(mesh, (i0, i1, i2) => {
        aw.fromBufferAttribute(position, i0).applyMatrix4(mesh.matrixWorld)
        bw.fromBufferAttribute(position, i1).applyMatrix4(mesh.matrixWorld)
        cw.fromBufferAttribute(position, i2).applyMatrix4(mesh.matrixWorld)
        mid.copy(aw).add(bw).add(cw).divideScalar(3)
        tyrePoints[(mid.x < 0 ? 0 : 1) + (mid.z < 0 ? 0 : 2)]!.push(
          aw.x, aw.y, aw.z, bw.x, bw.y, bw.z, cw.x, cw.y, cw.z,
        )
      })
    }
    const fits: (WheelFit | null)[] = tyrePoints.map((points) => this.fitWheel(points))
    const anyFit = fits.some((f) => f !== null)

    // Pass 2: sort every wheel-material triangle into its wheel.
    const groups = new Map<string, WheelGroup>()
    for (const mesh of sources) {
      const geometry = mesh.geometry
      const position = geometry.getAttribute('position')
      const indices: number[][] = [[], [], [], []]
      const boxes = [new THREE.Box3(), new THREE.Box3(), new THREE.Box3(), new THREE.Box3()]
      const rest: number[] = [] // triangles that belong to the body, not to a wheel

      this.forEachTriangle(mesh, (i0, i1, i2) => {
        a.fromBufferAttribute(position, i0)
        b.fromBufferAttribute(position, i1)
        c.fromBufferAttribute(position, i2)
        aw.copy(a).applyMatrix4(mesh.matrixWorld)
        bw.copy(b).applyMatrix4(mesh.matrixWorld)
        cw.copy(c).applyMatrix4(mesh.matrixWorld)
        mid.copy(aw).add(bw).add(cw).divideScalar(3)

        let corner = (mid.x < 0 ? 0 : 1) + (mid.z < 0 ? 0 : 2)
        if (anyFit) {
          // Belongs to the nearest tyre, but only if it lies inside that tyre's cylinder.
          let best = -1
          let bestDistance = Infinity
          fits.forEach((fit, k) => {
            if (!fit) return
            const d = mid.distanceToSquared(fit.centre)
            if (d < bestDistance) {
              bestDistance = d
              best = k
            }
          })
          const fit = fits[best]!
          offset.copy(mid).sub(fit.centre)
          const along = offset.dot(fit.axle)
          const radial = Math.sqrt(Math.max(0, offset.lengthSq() - along * along))
          if (radial > fit.radius * WHEEL_REACH || Math.abs(along) > fit.halfWidth + WHEEL_WIDTH_SLACK) {
            rest.push(i0, i1, i2)
            return
          }
          corner = best
        }

        indices[corner]!.push(i0, i1, i2)
        boxes[corner]!.expandByPoint(a).expandByPoint(b).expandByPoint(c)
      })

      for (let corner = 0; corner < 4; corner++) {
        const list = indices[corner]!
        if (list.length === 0) continue

        const split = this.subset(geometry, list)
        // Box3.setFromObject would otherwise measure the whole shared buffer, all four wheels.
        split.boundingBox = boxes[corner]!.clone()

        const part = new THREE.Mesh(split, mesh.material)
        mesh.matrixWorld.decompose(part.position, part.quaternion, part.scale)
        part.castShadow = mesh.castShadow
        part.receiveShadow = mesh.receiveShadow
        part.frustumCulled = false // its bounds would cover every wheel, and it moves when it spins
        root.add(part)

        const key = CORNER_KEYS[corner]!
        const group = groups.get(key)
        if (group) group.parts.push(part)
        else groups.set(key, { key, parts: [part], fit: fits[corner] ?? null })
      }

      // What isn't a wheel stays on the car, in the mesh it was in. Assigning a new geometry to
      // this copy of the mesh leaves the model's shared geometry untouched.
      if (rest.length > 0) {
        mesh.geometry = this.subset(geometry, rest)
        this.strayTriangles += rest.length / 3
      } else {
        mesh.removeFromParent()
      }
    }
    return [...groups.values()]
  }

  /**
   * Measures a tyre from its vertices (x, y, z, x, y, z, ...). The axle is the direction in which the
   * tyre is thinnest, so camber and toe come out of the geometry instead of being assumed away.
   * The centre is found by projecting the tyre onto that axle and taking the middle of its extent.
   */
  private fitWheel(points: number[]): WheelFit | null {
    const n = Math.floor(points.length / 3)
    if (n < 12) return null

    let mx = 0
    let my = 0
    let mz = 0
    for (let i = 0; i < n; i++) {
      mx += points[i * 3]!
      my += points[i * 3 + 1]!
      mz += points[i * 3 + 2]!
    }
    mx /= n
    my /= n
    mz /= n

    let xx = 0
    let xy = 0
    let xz = 0
    let yy = 0
    let yz = 0
    let zz = 0
    for (let i = 0; i < n; i++) {
      const x = points[i * 3]! - mx
      const y = points[i * 3 + 1]! - my
      const z = points[i * 3 + 2]! - mz
      xx += x * x
      xy += x * y
      xz += x * z
      yy += y * y
      yz += y * z
      zz += z * z
    }
    const axle = smallestEigenvector(
      [
        [xx, xy, xz],
        [xy, yy, yz],
        [xz, yz, zz],
      ].map((row) => row.map((value) => value / n)),
    )
    if (axle.x < 0) axle.negate() // a consistent direction, so every wheel spins the same way

    // Two directions perpendicular to the axle, to measure the tyre's size across.
    const helper = Math.abs(axle.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
    const u = helper.clone().addScaledVector(axle, -helper.dot(axle)).normalize()
    const v = new THREE.Vector3().crossVectors(axle, u)

    let minA = Infinity
    let maxA = -Infinity
    let minU = Infinity
    let maxU = -Infinity
    let minV = Infinity
    let maxV = -Infinity
    for (let i = 0; i < n; i++) {
      const dx = points[i * 3]! - mx
      const dy = points[i * 3 + 1]! - my
      const dz = points[i * 3 + 2]! - mz
      const along = dx * axle.x + dy * axle.y + dz * axle.z
      const pu = dx * u.x + dy * u.y + dz * u.z
      const pv = dx * v.x + dy * v.y + dz * v.z
      if (along < minA) minA = along
      if (along > maxA) maxA = along
      if (pu < minU) minU = pu
      if (pu > maxU) maxU = pu
      if (pv < minV) minV = pv
      if (pv > maxV) maxV = pv
    }

    const centre = new THREE.Vector3(mx, my, mz)
      .addScaledVector(axle, (minA + maxA) / 2)
      .addScaledVector(u, (minU + maxU) / 2)
      .addScaledVector(v, (minV + maxV) / 2)
    return {
      centre,
      axle,
      radius: Math.max(maxU - minU, maxV - minV) / 2,
      halfWidth: (maxA - minA) / 2,
    }
  }

  /** Calls `visit` with the three vertex indices of every triangle of a mesh. */
  private forEachTriangle(mesh: THREE.Mesh, visit: (i0: number, i1: number, i2: number) => void): void {
    const geometry = mesh.geometry
    const index = geometry.index
    const count = Math.floor((index ? index.count : geometry.getAttribute('position').count) / 3)
    for (let t = 0; t < count; t++) {
      if (index) visit(index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2))
      else visit(t * 3, t * 3 + 1, t * 3 + 2)
    }
  }

  /** A geometry that draws only the listed triangles, sharing the original's vertex data. */
  private subset(source: THREE.BufferGeometry, list: number[]): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    for (const [name, attribute] of Object.entries(source.attributes)) {
      geometry.setAttribute(name, attribute) // shared with the original, not copied
    }
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(list), 1))
    return geometry
  }

  /**
   * Puts each wheel's parts inside three nested pivots at the wheel's centre:
   * steer (turns about the vertical) > tilt (fixed, aligns x with the wheel's real axle) > spin.
   * Car.animate() sets steer.rotation.y and spin.rotation.x, and the tilt makes the spin
   * turn about the true axle, so a cambered wheel doesn't wobble.
   */
  private buildPivots(root: THREE.Group, groups: readonly WheelGroup[]): ModelWheel[] {
    root.updateMatrixWorld(true)
    const wheels: ModelWheel[] = []

    for (const group of groups) {
      let centre: THREE.Vector3
      let axle: THREE.Vector3
      let radius: number
      if (group.fit) {
        centre = group.fit.centre.clone()
        axle = group.fit.axle.clone()
        radius = group.fit.radius
      } else {
        // Found by node name: no tyre was measured, so assume a level axle through the box centre.
        const box = new THREE.Box3()
        for (const part of group.parts) box.union(new THREE.Box3().setFromObject(part))
        centre = box.getCenter(new THREE.Vector3())
        axle = AXLE_X.clone()
        radius = box.getSize(new THREE.Vector3()).y / 2
      }

      const steer = new THREE.Group()
      const tilt = new THREE.Group()
      const spin = new THREE.Group()
      steer.position.copy(centre)
      tilt.quaternion.setFromUnitVectors(AXLE_X, axle)
      steer.add(tilt)
      tilt.add(spin)
      root.add(steer)
      root.updateMatrixWorld(true)
      for (const part of group.parts) spin.attach(part) // keeps each part exactly where it was

      wheels.push({ steer, spin, front: group.key.endsWith('F'), radius: Math.max(radius, 0.1), axle })
    }
    return wheels
  }

  /** Says once per model how many wheels were found, and lists the names when there aren't four. */
  private report(url: string, root: THREE.Object3D, wheels: readonly ModelWheel[], method: string): void {
    if (this.reported.has(url)) return
    this.reported.add(url)

    const front = wheels.filter((w) => w.front).length
    console.info(`[CarModel] ${url}: ${wheels.length} wheels found by ${method} (${front} at the front)`)
    // Camber is the axle's tilt up or down, and toe is its tilt forward or back. A level, straight
    // axle gives 0 for both. A tyre sits on the ground, so its axle height should equal its radius.
    const degrees = (x: number): string => ((Math.asin(Math.max(-1, Math.min(1, x))) * 180) / Math.PI).toFixed(2)
    for (const w of wheels) {
      console.info(
        `[CarModel]   ${w.front ? 'front' : 'rear'} wheel: axle height ${w.steer.position.y.toFixed(3)} m, ` +
          `radius ${w.radius.toFixed(3)} m, camber ${degrees(w.axle.y)} deg, toe ${degrees(w.axle.z)} deg`,
      )
    }
    if (this.strayTriangles > 0) {
      console.info(`[CarModel]   ${this.strayTriangles} triangles share a wheel material but are not part of a wheel`)
    }
    if (wheels.length === 4) return

    const nodes: string[] = []
    const materials = new Set<string>()
    root.traverse((o) => {
      if (o.name) nodes.push(o.name)
      if (!(o instanceof THREE.Mesh)) return
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m.name)
    })
    console.warn(
      `[CarModel] Expected 4 wheels. Set wheelPattern (node names) or wheelMaterialPattern ` +
        `(material names) in MODEL_OPTIONS in main.ts. Materials: ${[...materials].join(', ')}. ` +
        `Nodes: ${nodes.slice(0, 60).join(', ')}` +
        (nodes.length > 60 ? ` ... (${nodes.length - 60} more)` : ''),
    )
  }

  /** Prints what a model contains, once, which is what you need to set `yaw` and `paintPattern`. */
  private describe(url: string, scene: THREE.Object3D): void {
    const size = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3())
    const names = new Set<string>()
    scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      const materials = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of materials) names.add(m.name || '(unnamed)')
    })
    console.info(
      `[CarModel] ${url}: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} ` +
        `(x, y, z). Materials: ${[...names].join(', ')}`,
    )
    if (size.x > size.z * 1.2) {
      console.warn(
        `[CarModel] ${url} is wider than it is long, so it probably points along the x axis. ` +
          `Try yaw: Math.PI / 2 or -Math.PI / 2.`,
      )
    }
  }
}