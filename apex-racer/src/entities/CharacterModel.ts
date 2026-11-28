import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'

export interface CharacterOptions {
  /** Where the .glb file is served from, e.g. '/models/character.glb' for public/models/character.glb. */
  url: string
  /** Height of the finished character in metres. The model is scaled to match, so its own units don't matter. */
  height?: number
  /**
   * Extra turn about the vertical axis, in radians. By default the facing direction is measured from the
   * model's feet, so this is only needed if that comes out wrong. 0 means the model already faces -Z.
   */
  yaw?: number
}

/** Fraction from 0 to 1, or null when the server didn't say how big the file is. */
export type LoadProgress = (fraction: number | null) => void

/** The bones the animation code uses, found by name. A bone the model doesn't have is null. */
const BONE_PATTERNS = {
  hips: /^CC_Base_Hip_\d+$/,
  pelvis: /^CC_Base_Pelvis_\d+$/,
  waist: /^CC_Base_Waist_\d+$/,
  spine1: /^CC_Base_Spine01_\d+$/,
  spine2: /^CC_Base_Spine02_\d+$/,
  head: /^CC_Base_Head_\d+$/,
  lThigh: /^CC_Base_L_Thigh_\d+$/,
  lCalf: /^CC_Base_L_Calf_\d+$/,
  lFoot: /^CC_Base_L_Foot_\d+$/,
  lToe: /^CC_Base_L_ToeBase_\d+$/,
  rThigh: /^CC_Base_R_Thigh_\d+$/,
  rCalf: /^CC_Base_R_Calf_\d+$/,
  rFoot: /^CC_Base_R_Foot_\d+$/,
  rToe: /^CC_Base_R_ToeBase_\d+$/,
  lClavicle: /^CC_Base_L_Clavicle_\d+$/,
  lUpperarm: /^CC_Base_L_Upperarm_\d+$/,
  lForearm: /^CC_Base_L_Forearm_\d+$/,
  lHand: /^CC_Base_L_Hand_\d+$/,
  rClavicle: /^CC_Base_R_Clavicle_\d+$/,
  rUpperarm: /^CC_Base_R_Upperarm_\d+$/,
  rForearm: /^CC_Base_R_Forearm_\d+$/,
  rHand: /^CC_Base_R_Hand_\d+$/,
} as const

export type BoneKey = keyof typeof BONE_PATTERNS
export type CharacterBones = Record<BoneKey, THREE.Bone | null>

const BONE_KEYS = Object.keys(BONE_PATTERNS) as BoneKey[]

const DEFAULT_HEIGHT = 1.7
// Materials drawn as cut-outs: every pixel of the texture is either solid or fully clear. That is
// much cheaper than blending, and the hair needs no sorting.
const CUTOUT_MATERIALS = /hair|scalp|eyelash|female_angled/i
const CUTOUT_THRESHOLD = 0.5

/** A character ready to stand in the scene: its feet are at the origin and it faces -Z. */
export class Character {
  /** Add this to the scene. Move and turn this to move and turn the character. */
  readonly object: THREE.Group
  readonly height: number
  /** The model's bones, for animation. The rest pose of each is in `rest`. */
  readonly bones: CharacterBones
  /** Each bone's rotation as loaded, so an animation can add to it instead of replacing it. */
  readonly rest = new Map<THREE.Bone, THREE.Quaternion>()
  /** The hidden capsule that casts the shadow instead of the detailed model. */
  readonly shadowProxy: THREE.Mesh

  private readonly meshes: readonly THREE.Mesh[]
  private detailedShadows = false

  constructor(
    object: THREE.Group,
    height: number,
    bones: CharacterBones,
    meshes: readonly THREE.Mesh[],
    shadowProxy: THREE.Mesh,
  ) {
    this.object = object
    this.height = height
    this.bones = bones
    this.meshes = meshes
    this.shadowProxy = shadowProxy
    for (const key of BONE_KEYS) {
      const bone = bones[key]
      if (bone) this.rest.set(bone, bone.quaternion.clone())
    }
    this.applyShadowMode()
  }

  /**
   * Chooses what casts the character's shadow. false (the default): a hidden capsule does, which is far
   * cheaper to draw. true: the detailed model casts its own exact shadow.
   */
  setDetailedShadows(detailed: boolean): void {
    this.detailedShadows = detailed
    this.applyShadowMode()
  }

  /** Removes the character from the scene and frees what belongs to it alone. The model's geometry and textures are shared, and CharacterLoader.dispose() frees them. */
  dispose(): void {
    this.shadowProxy.geometry.dispose()
    ;(this.shadowProxy.material as THREE.Material).dispose()
    this.object.removeFromParent()
  }

  private applyShadowMode(): void {
    this.shadowProxy.visible = !this.detailedShadows
    for (const mesh of this.meshes) mesh.castShadow = this.detailedShadows
  }
}

export class CharacterLoader {
  private readonly loader = new GLTFLoader()
  private readonly pending = new Map<string, Promise<THREE.Group>>()
  private readonly loaded = new Map<string, THREE.Group>()
  private readonly reported = new Set<string>()

  /** Downloads and parses a model once per URL. The result is the shared template: don't add it to a scene. */
  load(url: string, onProgress?: LoadProgress): Promise<THREE.Group> {
    let promise = this.pending.get(url)
    if (!promise) {
      promise = new Promise<THREE.Group>((resolve, reject) => {
        this.loader.load(
          url,
          (gltf) => {
            this.prepareMaterials(gltf.scene)
            this.loaded.set(url, gltf.scene)
            resolve(gltf.scene)
          },
          (event) => onProgress?.(event.lengthComputable ? event.loaded / event.total : null),
          (error) => reject(error instanceof Error ? error : new Error(`Could not load ${url}`)),
        )
      })
      this.pending.set(url, promise)
      promise.catch(() => this.pending.delete(url)) // a failed download isn't remembered, so it can be retried
    }
    return promise
  }

  /** A ready-to-use character: scaled, standing on the origin, facing -Z, with its bones found. */
  async create(options: CharacterOptions, onProgress?: LoadProgress): Promise<Character> {
    const template = await this.load(options.url, onProgress)
    const height = options.height ?? DEFAULT_HEIGHT

    // SkeletonUtils.clone makes a copy whose meshes are bound to the copy's own bones. A plain clone
    // would leave the new meshes following the original skeleton.
    const model = SkeletonUtils.clone(template)
    const inner = new THREE.Group() // turned, scaled and shifted so the feet sit on the origin
    inner.add(model)
    const root = new THREE.Group()
    root.add(inner)
    root.updateMatrixWorld(true)

    const bones = this.findBones(model)

    // Which way is forward? Each foot's toe points forward from its ankle. Without the bones, assume
    // the model faces +z, which is what most glTF models do.
    const measured = this.measureYaw(bones)
    inner.rotation.y = options.yaw ?? measured ?? Math.PI
    root.updateMatrixWorld(true)

    // Scale so the standing height is right. Measuring from the skinned vertices (precise) includes the pose.
    const box = new THREE.Box3().setFromObject(inner, true)
    const size = box.getSize(new THREE.Vector3())
    const scale = height / Math.max(size.y, 1e-4)
    inner.scale.setScalar(scale)
    root.updateMatrixWorld(true)

    // Put the feet on the ground, in the middle of the origin.
    box.setFromObject(inner, true)
    const centre = box.getCenter(new THREE.Vector3())
    inner.position.set(-centre.x, -box.min.y, -centre.z)
    root.updateMatrixWorld(true)

    const meshes: THREE.Mesh[] = []
    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      o.frustumCulled = false // the pose changes the shape, and there are only a few meshes
      o.castShadow = false
      o.receiveShadow = true
      meshes.push(o)
    })

    // The stand-in shadow caster: nothing is written to the screen, but it is drawn into the shadow map.
    const radius = height * 0.13
    const proxy = new THREE.Mesh(
      new THREE.CapsuleGeometry(radius, height * 0.92 - 2 * radius, 4, 8),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    )
    proxy.position.y = height * 0.5
    root.add(proxy)

    this.report(options.url, template, size.y, scale, measured, bones, height)
    return new Character(root, height, bones, meshes, proxy)
  }

  /** Frees the shared model's geometry, materials and textures. Call it once no character is left. */
  dispose(): void {
    for (const scene of this.loaded.values()) {
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return
        o.geometry.dispose()
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose()
          m.dispose()
        }
      })
    }
    this.loaded.clear()
    this.pending.clear()
  }

  /** Turns the hair, lashes and brows into cut-outs. Done once on the shared template. */
  private prepareMaterials(scene: THREE.Object3D): void {
    scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!CUTOUT_MATERIALS.test(m.name)) continue
        m.transparent = false
        m.alphaTest = CUTOUT_THRESHOLD
        m.depthWrite = true
        m.side = THREE.DoubleSide
        m.needsUpdate = true
      }
    })
  }

  private findBones(model: THREE.Object3D): CharacterBones {
    const bones = {} as CharacterBones
    for (const key of BONE_KEYS) bones[key] = null
    model.traverse((o) => {
      if (!(o as THREE.Bone).isBone) return
      for (const key of BONE_KEYS) {
        if (!bones[key] && BONE_PATTERNS[key].test(o.name)) bones[key] = o as THREE.Bone
      }
    })
    return bones
  }

  /** The turn about the vertical axis that makes the model face -Z, from the direction its feet point. */
  private measureYaw(bones: CharacterBones): number | null {
    const foot = new THREE.Vector3()
    const toe = new THREE.Vector3()
    let fx = 0
    let fz = 0
    for (const [a, b] of [
      [bones.lFoot, bones.lToe],
      [bones.rFoot, bones.rToe],
    ] as const) {
      if (!a || !b) continue
      a.getWorldPosition(foot)
      b.getWorldPosition(toe)
      fx += toe.x - foot.x
      fz += toe.z - foot.z
    }
    if (Math.hypot(fx, fz) < 1e-6) return null
    // Rotating by this angle turns the measured forward direction onto -Z.
    return Math.atan2(fx, -fz)
  }

  /** Says once per model what was found, which is what you need if the facing, size or bones come out wrong. */
  private report(
    url: string,
    template: THREE.Object3D,
    modelHeight: number,
    scale: number,
    yaw: number | null,
    bones: CharacterBones,
    height: number,
  ): void {
    if (this.reported.has(url)) return
    this.reported.add(url)

    let triangles = 0
    let meshCount = 0
    template.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      meshCount++
      const index = o.geometry.index
      triangles += (index ? index.count : o.geometry.getAttribute('position').count) / 3
    })
    const found = BONE_KEYS.filter((k) => bones[k] !== null).length
    console.info(
      `[Character] ${url}: ${meshCount} meshes, ${triangles} triangles. Scaled to ${height.toFixed(2)} m ` +
        `(the model measured ${modelHeight.toFixed(2)} units, scale ${scale.toFixed(4)}). ` +
        `Facing ${yaw === null ? 'not measured, assuming +z' : `measured, turned ${((yaw * 180) / Math.PI).toFixed(0)} deg`}. ` +
        `Bones found: ${found} of ${BONE_KEYS.length}.`,
    )
    const missing = BONE_KEYS.filter((k) => bones[k] === null)
    if (missing.length > 0) console.warn(`[Character] Bones not found: ${missing.join(', ')}`)
  }
}