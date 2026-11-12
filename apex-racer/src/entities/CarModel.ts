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
  /** Named wheel assembly roots; their hub positions and axle directions are derived from geometry. */
  wheelAssemblies?: readonly CarWheelAssemblyOption[]
}

export interface CarWheelAssemblyOption {
  nodeName: string
  front: boolean
}

export interface CarWheelRigMetadata {
  front: boolean
  hub: readonly [number, number, number]
  axleAxis: readonly [number, number, number]
}

/** Fraction from 0 to 1, or null when the server didn't say how big the file is. */
export type LoadProgress = (fraction: number | null) => void

export const CAR_WHEEL_RIG_KEY = 'apexRacerWheelRig'

const DEFAULT_LENGTH = 4.2
const DEFAULT_YAW = Math.PI
const DEFAULT_PAINT_PATTERN = /body|paint/i

interface PrincipalAxes {
  axes: THREE.Vector3[]
  values: number[]
}

function principalAxes(points: readonly THREE.Vector3[]): PrincipalAxes {
  const mean = new THREE.Vector3()
  for (const point of points) mean.add(point)
  mean.multiplyScalar(1 / points.length)

  const matrix = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (const point of points) {
    const d = [point.x - mean.x, point.y - mean.y, point.z - mean.z]
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) {
        matrix[row]![column] += d[row]! * d[column]!
      }
    }
  }

  const vectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  for (let iteration = 0; iteration < 32; iteration++) {
    let p = 0
    let q = 1
    for (let row = 0; row < 3; row++) {
      for (let column = row + 1; column < 3; column++) {
        if (Math.abs(matrix[row]![column]!) > Math.abs(matrix[p]![q]!)) {
          p = row
          q = column
        }
      }
    }
    const offDiagonal = matrix[p]![q]!
    if (Math.abs(offDiagonal) < 1e-12) break

    const tau = (matrix[q]![q]! - matrix[p]![p]!) / (2 * offDiagonal)
    const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau))
    const c = 1 / Math.sqrt(1 + t * t)
    const s = t * c
    const pp = matrix[p]![p]!
    const qq = matrix[q]![q]!

    for (let index = 0; index < 3; index++) {
      if (index === p || index === q) continue
      const ip = matrix[index]![p]!
      const iq = matrix[index]![q]!
      matrix[index]![p] = matrix[p]![index] = c * ip - s * iq
      matrix[index]![q] = matrix[q]![index] = s * ip + c * iq
    }
    matrix[p]![p] = pp - t * offDiagonal
    matrix[q]![q] = qq + t * offDiagonal
    matrix[p]![q] = matrix[q]![p] = 0

    for (let row = 0; row < 3; row++) {
      const vp = vectors[row]![p]!
      const vq = vectors[row]![q]!
      vectors[row]![p] = c * vp - s * vq
      vectors[row]![q] = s * vp + c * vq
    }
  }

  return {
    values: [matrix[0]![0]!, matrix[1]![1]!, matrix[2]![2]!],
    axes: [0, 1, 2].map((column) =>
      new THREE.Vector3(
        vectors[0]![column]!,
        vectors[1]![column]!,
        vectors[2]![column]!,
      ).normalize(),
    ),
  }
}

function wheelGeometryPoints(
  assembly: THREE.Object3D,
  coordinateRoot: THREE.Object3D,
): THREE.Vector3[] {
  const rootInverse = coordinateRoot.matrixWorld.clone().invert()
  const points: THREE.Vector3[] = []

  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    object.geometry.computeBoundingBox()
    const bounds = object.geometry.boundingBox
    if (!bounds) return

    const objectToRoot = rootInverse.clone().multiply(object.matrixWorld)
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          points.push(new THREE.Vector3(x, y, z).applyMatrix4(objectToRoot))
        }
      }
    }
  })

  return points
}

function wheelRigMetadata(
  points: readonly THREE.Vector3[],
  front: boolean,
): CarWheelRigMetadata {
  if (points.length === 0) throw new Error('Wheel assembly contains no mesh geometry')

  const { axes, values } = principalAxes(points)
  let axleIndex = 0
  for (let i = 1; i < values.length; i++) {
    if (values[i]! < values[axleIndex]!) axleIndex = i
  }
  // The wheel axle is the principal direction with the least spread in the transformed bounds.
  const axleAxis = axes[axleIndex]!
  const dominantAxis = [axleAxis.x, axleAxis.y, axleAxis.z].reduce((best, value) =>
    Math.abs(value) > Math.abs(best) ? value : best,
  )
  if (dominantAxis < 0) axleAxis.negate()

  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const point of points) {
    for (let i = 0; i < axes.length; i++) {
      const projection = point.dot(axes[i]!)
      min[i] = Math.min(min[i]!, projection)
      max[i] = Math.max(max[i]!, projection)
    }
  }
  const hub = new THREE.Vector3()
  for (let i = 0; i < axes.length; i++) {
    hub.addScaledVector(axes[i]!, (min[i]! + max[i]!) / 2)
  }

  return {
    front,
    hub: [hub.x, hub.y, hub.z],
    axleAxis: [axleAxis.x, axleAxis.y, axleAxis.z],
  }
}

export class CarModelLoader {
  private readonly loader = new GLTFLoader()
  private readonly cache = new Map<string, Promise<THREE.Group>>()

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

  /** A ready-to-use copy of the model: scaled, centred, facing -Z, and optionally repainted. */
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

    if (options.wheelAssemblies?.length) {
      this.registerWheelAssemblies(root, model, options.wheelAssemblies)
    }
    this.applyPaint(model, options)
    return root
  }

  private registerWheelAssemblies(
    root: THREE.Group,
    model: THREE.Group,
    wheelOptions: readonly CarWheelAssemblyOption[],
  ): void {
    root.updateMatrixWorld(true)
    const names = new Map<string, THREE.Object3D[]>()
    model.traverse((object) => {
      if (!wheelOptions.some((wheel) => wheel.nodeName === object.name)) return
      const matches = names.get(object.name) ?? []
      matches.push(object)
      names.set(object.name, matches)
    })

    for (const wheel of wheelOptions) {
      const matches = names.get(wheel.nodeName) ?? []
      if (matches.length !== 1) {
        throw new Error(
          `Expected one wheel assembly named "${wheel.nodeName}", found ${matches.length}`,
        )
      }
      const assembly = matches[0]!
      const points = wheelGeometryPoints(assembly, root)
      assembly.userData[CAR_WHEEL_RIG_KEY] = wheelRigMetadata(points, wheel.front)
    }
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