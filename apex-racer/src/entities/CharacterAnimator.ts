import * as THREE from 'three'
import type { BoneKey, Character, CharacterBones } from '@/entities/CharacterModel'

const TAU = Math.PI * 2
const X_AXIS = new THREE.Vector3(1, 0, 0)
const Y_AXIS = new THREE.Vector3(0, 1, 0)
const Z_AXIS = new THREE.Vector3(0, 0, 1)

/**
 * How the body moves at one gait. All angles are in radians, in the character's own frame:
 * +X is to her right, +Y is up, and she faces -Z.
 */
export interface GaitParams {
  thighSwing: number // how far each thigh swings forward and back from straight down
  kneeBend: number // the most a knee bends, during the swing
  armSwing: number // how far each arm swings forward and back
  elbowBend: number // how much the elbows are bent at the middle of the swing
  lean: number // forward lean of the torso
  pelvisYaw: number // the hips turning toward the leading leg
  spineYaw: number // the shoulders turning the other way
  bob: number // metres the body dips between steps
  hipRoll: number // how far the hip on the swinging leg's side drops
  hipSway: number // metres the body shifts sideways over the leg it is standing on
}

export interface GaitTuning {
  /** Set to -1 if the legs and arms swing the wrong way, which would also turn the lean around. */
  swingSign: 1 | -1
  /** How far the arms are lowered toward the body, in radians. The model's arms start 60 degrees out. Negative raises them. */
  armAdduction: number
  walk: GaitParams
  run: GaitParams
  /** Metres travelled in one full stride (two steps) when walking and when running. */
  walkCycle: number
  runCycle: number
  /** Speeds, in m/s: she is walking from `walkFrom`, and fully running from `runFull`. */
  walkFrom: number
  runStart: number
  runFull: number
}

const POSED: readonly BoneKey[] = [
  'pelvis',
  'waist',
  'spine1',
  'spine2',
  'head',
  'lThigh',
  'rThigh',
  'lCalf',
  'rCalf',
  'lFoot',
  'rFoot',
  'lUpperarm',
  'rUpperarm',
  'lForearm',
  'rForearm',
  'lHand',
  'rHand',
]

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function smooth(v: number): number {
  const t = clamp01(v)
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export class CharacterAnimator {
  /** Every number that shapes the motion. Safe to change live, e.g. in the browser console: anim.tuning.walk.armSwing = 0.5 */
  readonly tuning: GaitTuning = {
    swingSign: 1,
    armAdduction: 0.84,
    walk: {
      thighSwing: 0.42,
      kneeBend: 0.85,
      armSwing: 0.42,
      elbowBend: 0.3,
      lean: 0.02,
      pelvisYaw: 0.12,
      spineYaw: 0.18,
      bob: 0.025,
      hipRoll: 0.06,
      hipSway: 0.025,
    },
    run: {
      thighSwing: 0.85,
      kneeBend: 1.7,
      armSwing: 0.9,
      elbowBend: 1.25,
      lean: 0.22,
      pelvisYaw: 0.18,
      spineYaw: 0.26,
      bob: 0.05,
      hipRoll: 0.05,
      hipSway: 0.012,
    },
    walkCycle: 1.55,
    runCycle: 3.2,
    walkFrom: 0.9,
    runStart: 2.2,
    runFull: 4.6,
  }

  private readonly object: THREE.Object3D
  private readonly bones: CharacterBones
  private readonly restChar = new Map<THREE.Bone, THREE.Quaternion>() // each bone's rest orientation in the character's frame
  private readonly restHips = new THREE.Vector3()

  private speed = 0 // the smoothed ground speed, m/s
  private phase = 0 // where she is in her stride, in radians
  private time = 0
  private legThigh = 0
  private legCalf = 0
  private legFoot = 0
  private armUpper = 0
  private armFore = 0

  // Scratch objects, reused every frame so the animation makes no garbage.
  private readonly gait: GaitParams = {
    thighSwing: 0,
    kneeBend: 0,
    armSwing: 0,
    elbowBend: 0,
    lean: 0,
    pelvisYaw: 0,
    spineYaw: 0,
    bob: 0,
    hipRoll: 0,
    hipSway: 0,
  }
  private readonly rootInv = new THREE.Quaternion()
  private readonly rootQ = new THREE.Quaternion()
  private readonly parentQ = new THREE.Quaternion()
  private readonly want = new THREE.Quaternion()
  private readonly delta = new THREE.Quaternion()
  private readonly tmp = new THREE.Quaternion()
  private readonly v = new THREE.Vector3()
  private readonly scale = new THREE.Vector3()

  /** Call it right after the character is created, while she is still in her rest pose. */
  constructor(character: Character) {
    this.object = character.object
    this.bones = character.bones

    // Each bone's rest orientation, measured in the character's own frame.
    character.object.updateMatrixWorld(true)
    const rootInv = character.object.getWorldQuaternion(new THREE.Quaternion()).invert()
    const q = new THREE.Quaternion()
    for (const key of POSED) {
      const bone = this.bones[key]
      if (!bone) continue
      bone.getWorldQuaternion(q)
      this.restChar.set(bone, rootInv.clone().multiply(q))
    }
    if (this.bones.hips) this.restHips.copy(this.bones.hips.position)
  }

  /** How fast she is moving over the ground, in m/s. Zero stands, about 1.4 walks, and about 4.5 runs. */
  get groundSpeed(): number {
    return this.speed
  }

  /** Call once per display frame. `speed` is her speed over the ground, in m/s. The character itself is moved by the caller. */
  update(dt: number, speed: number): void {
    const t = this.tuning
    const sign = t.swingSign

    // Smooth the speed, so starting, stopping and changing gait blend instead of snapping.
    this.speed += (Math.max(0, speed) - this.speed) * (1 - Math.exp(-8 * dt))
    this.time += dt

    const move = smooth(this.speed / t.walkFrom) // 0 standing, 1 once she is walking
    const run = smooth((this.speed - t.runStart) / (t.runFull - t.runStart)) // 0 walking, 1 running
    const cycle = lerp(t.walkCycle, t.runCycle, run)
    this.phase = (this.phase + (this.speed / cycle) * TAU * dt) % (TAU * 1000)

    const g = this.gait
    for (const key of Object.keys(g) as (keyof GaitParams)[]) g[key] = lerp(t.walk[key], t.run[key], run)

    this.object.getWorldQuaternion(this.rootQ)
    this.rootInv.copy(this.rootQ).invert()

    const ph = this.phase
    const swing = Math.sin(ph) * move // + when her left leg is forward
    const left = ph
    const right = ph + Math.PI

    // The pelvis drops on the side of the swinging leg: when the left leg is planted (cos < 0) the right
    // hip goes down. The body also shifts sideways over the planted leg, and dips between steps. Everything
    // hangs from the hips, so the feet move with it, which is small.
    const roll = g.hipRoll * Math.cos(ph) * move
    this.moveHips(g.hipSway * Math.cos(ph) * move, g.bob * 0.5 * (Math.cos(2 * ph) - 1) * move)

    // Torso. Pitch is negative when leaning forward. The shoulders turn against the hips, and stay level
    // by taking only a little of the hip roll.
    const lean = -g.lean * move
    const breathe = Math.sin(this.time * 1.9) * 0.012 * (1 - move)
    const shift = Math.sin(this.time * 0.45) * 0.015 * (1 - move)
    const hipYaw = -g.pelvisYaw * swing // the left hip goes forward with the left leg
    const shoulderYaw = g.spineYaw * swing
    this.pose('pelvis', sign * lean * 0.15, hipYaw, shift + roll)
    this.pose('waist', sign * lean * 0.4, shoulderYaw * 0.3, roll * 0.6)
    this.pose('spine1', sign * lean * 0.7, shoulderYaw * 0.6, roll * 0.3)
    this.pose('spine2', sign * (lean + breathe), shoulderYaw * 0.9, roll * 0.1)

    // The head follows the torso part of the way: it takes some of the lean and the twist, nods in time with
    // her steps, glances about slowly when she is standing, and keeps level.
    const glance = Math.sin(this.time * 0.37) * 0.05 * (1 - move)
    const nod = Math.sin(2 * ph + 0.6) * 0.025 * move
    this.pose('head', sign * (lean * 0.55 + nod), shoulderYaw * 0.45 + glance, 0)

    // Legs.
    this.legPose(left, g, move)
    this.pose('lThigh', sign * this.legThigh, 0, 0)
    this.pose('lCalf', sign * this.legCalf, 0, 0)
    this.pose('lFoot', sign * this.legFoot, 0, 0)
    this.legPose(right, g, move)
    this.pose('rThigh', sign * this.legThigh, 0, 0)
    this.pose('rCalf', sign * this.legCalf, 0, 0)
    this.pose('rFoot', sign * this.legFoot, 0, 0)

    // Arms: each swings against the leg on its own side. Lowering them toward the body is a turn about the
    // forward axis, to the left arm one way and to the right arm the other.
    const a = t.armAdduction
    this.armPose(left, g, move)
    this.pose('lUpperarm', sign * this.armUpper, 0, a)
    this.pose('lForearm', sign * this.armFore, 0, a)
    this.pose('lHand', sign * this.armFore, 0, a)
    this.armPose(right, g, move)
    this.pose('rUpperarm', sign * this.armUpper, 0, -a)
    this.pose('rForearm', sign * this.armFore, 0, -a)
    this.pose('rHand', sign * this.armFore, 0, -a)
  }

  /** A leg's angles at one point in its stride. `ph` is 0 when the leg is passing the other, moving forward. */
  private legPose(ph: number, g: GaitParams, move: number): void {
    const s = Math.sin(ph)
    // The leg reaches further forward than it trails behind, so the swing is not centred on straight down.
    const thigh = g.thighSwing * (0.9 * s + 0.2)
    // The knee bends most in the middle of the forward swing, and is straight as the heel lands.
    const bend = g.kneeBend * Math.pow(Math.max(0, Math.cos(ph + 0.35)), 1.4) + 0.08
    // Toes up as the heel lands, toes down as the foot pushes off.
    const foot = 0.2 * Math.max(0, s) - 0.5 * Math.max(0, -s)
    this.legThigh = move * thigh
    this.legCalf = move * (thigh - bend)
    this.legFoot = move * foot
  }

  /** An arm's angles, swinging against the leg with phase `ph`. The forearm lags behind the upper arm. */
  private armPose(ph: number, g: GaitParams, move: number): void {
    const swing = -g.armSwing * Math.sin(ph - 0.15) * move
    const lag = -0.3 * g.armSwing * Math.sin(ph - 0.9) * move
    this.armUpper = swing
    // The elbow bends more as the arm comes forward.
    this.armFore = swing + lerp(0.12, g.elbowBend, move) + 0.5 * Math.max(0, swing) + lag
  }

  /** Moves the hips, and with them the whole body, by `x` metres to her right and `y` metres up, in the character's frame. */
  private moveHips(x: number, y: number): void {
    const hips = this.bones.hips
    if (!hips || !hips.parent) return
    hips.parent.getWorldQuaternion(this.parentQ)
    hips.parent.getWorldScale(this.scale)
    // A metre in the character's frame, expressed in the parent bone's own units (this skeleton's bones are in centimetres).
    this.v.set(x, y, 0).applyQuaternion(this.rootQ).applyQuaternion(this.parentQ.invert()).divideScalar(this.scale.x)
    hips.position.copy(this.restHips).add(this.v)
  }

  /**
   * Gives a bone the orientation "its rest orientation, turned by (rx, ry, rz)", where the turns are about
   * the character's own axes: x is to her right, y is up and z points behind her. The bone's own local
   * axes never matter. The result is converted into the bone's rotation relative to its parent, as the
   * parent is posed right now, so parents must be posed before their children.
   */
  private pose(key: BoneKey, rx: number, ry: number, rz: number): void {
    const bone = this.bones[key]
    if (!bone || !bone.parent) return
    const rest = this.restChar.get(bone)
    if (!rest) return

    // The turn: about y, then x, then z (small angles, so the order hardly matters).
    this.delta.setFromAxisAngle(Y_AXIS, ry)
    this.tmp.setFromAxisAngle(X_AXIS, rx)
    this.delta.multiply(this.tmp)
    this.tmp.setFromAxisAngle(Z_AXIS, rz)
    this.delta.multiply(this.tmp)

    this.want.copy(this.delta).multiply(rest) // the wanted orientation, in the character's frame

    bone.parent.getWorldQuaternion(this.parentQ) // brings the parent's pose up to date as well
    this.parentQ.premultiply(this.rootInv).invert() // the parent's orientation in the character's frame, inverted
    bone.quaternion.copy(this.parentQ).multiply(this.want)
  }
}