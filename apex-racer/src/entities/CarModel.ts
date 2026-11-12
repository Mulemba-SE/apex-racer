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
}

/** Fraction from 0 to 1, or null when the server didn't say how big the file is. */
export type LoadProgress = (fraction: number | null) => void

const DEFAULT_LENGTH = 4.2
const DEFAULT_YAW = Math.PI
const DEFAULT_PAINT_PATTERN = /body|paint/i

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

    this.applyPaint(model, options)
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