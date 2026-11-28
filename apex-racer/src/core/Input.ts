export interface Controls {
  throttle: number // 0..1
  brake: number // 0..1
  steer: number // -1 (left) .. 1 (right)
  handbrake: boolean
}

/** How the player is moving on foot. Filled in every fixed step while on foot, and zero otherwise. */
export interface FootControls {
  forward: number // -1 (back) .. 1 (forward), relative to the camera
  strafe: number // -1 (left) .. 1 (right), relative to the camera
  run: boolean
  look: number // -1 .. 1: turning the camera with the Q and E keys
}

/** How the car is steered. 'mouse' adds the cursor and mouse buttons; the keyboard always works too. */
export type ControlScheme = 'keyboard' | 'mouse'

export const CONTROL_SCHEMES: readonly ControlScheme[] = ['keyboard', 'mouse']

/** What the keys control right now: the car, or the character on foot. */
export type InputTarget = 'car' | 'foot'

// KeyboardEvent.code is the physical key position, so WASD keeps working
// on non-QWERTY layouts.
const BINDINGS = {
  throttle: ['KeyW', 'ArrowUp'], // on foot: walk forward
  brake: ['KeyS', 'ArrowDown'], // on foot: walk back
  left: ['KeyA', 'ArrowLeft'], // on foot: step left
  right: ['KeyD', 'ArrowRight'], // on foot: step right
  handbrake: ['Space'],
  run: ['ShiftLeft', 'ShiftRight'],
  lookLeft: ['KeyQ'], // on foot: turn the camera
  lookRight: ['KeyE'],
  interact: ['KeyF'], // get out of the car, or get back in
  reset: ['KeyR'],
  confirm: ['Enter', 'NumpadEnter'], // starts the race from the menu
  camera: ['KeyC'], // cycles the camera view
  pause: ['Escape', 'KeyP'], // pauses and resumes
} as const

const BOUND_CODES = new Set<string>(Object.values(BINDINGS).flat())

const LEFT_BUTTON = 0 // MouseEvent.button: throttle in mouse mode
const RIGHT_BUTTON = 2 // brake in mouse mode, and the camera drag on foot

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function matches(codes: readonly string[], code: string): boolean {
  return codes.includes(code)
}

/** True when an event is aimed at a button, dropdown or text field, which needs its keys and clicks for itself. */
function isInteractive(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('button, select, input, textarea, [contenteditable]') !== null
}

export class Input {
  readonly controls: Controls = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
  }

  /** The walking controls. All zero while the keys control the car. */
  readonly foot: FootControls = {
    forward: 0,
    strafe: 0,
    run: false,
    look: 0,
  }

  /**
   * Cursor-steering tuning, in fractions of half the window's width from the centre. Safe to change
   * at any time, e.g. input.mouse.fullLock = 0.45 in the browser console.
   */
  readonly mouse = {
    deadZone: 0.05, // no steering inside this, so the car runs straight with a resting hand
    fullLock: 0.6, // full steering at this distance from the centre
    curve: 1.3, // above 1 makes small movements gentler; 1 is linear
  }

  /**
   * While true, the car sees no input at all. Held keys are remembered, so anything still held when the
   * lock ends takes effect on the next step. It only affects the car: walking is never locked.
   */
  locked = false

  private current: ControlScheme = 'keyboard'
  private currentTarget: InputTarget = 'car'
  private mouseX = 0 // the cursor's horizontal position, -1 (left edge) to 1 (right edge)
  private dragging = false // the right mouse button is held to turn the camera
  private readonly drag = { x: 0, y: 0 } // the pixels the mouse has moved while dragging, since takeLook()
  private readonly mouseButtons = new Set<number>()
  private readonly keys = new Set<string>()
  private resetQueued = false
  private confirmQueued = false
  private cameraQueued = false
  private pauseQueued = false
  private interactQueued = false

  constructor() {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('contextmenu', this.onContextMenu)
    document.documentElement.addEventListener('mouseleave', this.onMouseLeave)
  }

  get scheme(): ControlScheme {
    return this.current
  }

  setScheme(scheme: ControlScheme): void {
    this.current = scheme
    if (scheme === 'keyboard') this.mouseButtons.clear() // a button held at the switch must not stay pressed
  }

  /** What the keys control right now. */
  get target(): InputTarget {
    return this.currentTarget
  }

  /**
   * Switches the keys between the car and the character on foot. The car's controls go to zero with its
   * handbrake held, so a parked car stays where it is. Keys that are held carry over: if W is down, the
   * character starts walking at once.
   */
  setTarget(target: InputTarget): void {
    if (target === this.currentTarget) return
    this.currentTarget = target
    this.mouseButtons.clear()
    this.dragging = false
    this.drag.x = 0
    this.drag.y = 0
    // A press made in the other mode must not fire in this one.
    this.resetQueued = false
    this.confirmQueued = false
    if (target === 'foot') {
      const c = this.controls
      c.throttle = 0
      c.brake = 0
      c.steer = 0
      c.handbrake = true
    }
  }

  /** Samples the held keys and the mouse into `controls` and `foot`. Call once per fixed step. */
  update(_dt: number): void {
    const c = this.controls
    const f = this.foot
    const keySteer = (this.down(BINDINGS.right) ? 1 : 0) - (this.down(BINDINGS.left) ? 1 : 0)

    if (this.currentTarget === 'foot') {
      c.throttle = 0
      c.brake = 0
      c.steer = 0
      c.handbrake = true // the parked car stays put
      f.forward = (this.down(BINDINGS.throttle) ? 1 : 0) - (this.down(BINDINGS.brake) ? 1 : 0)
      f.strafe = keySteer
      f.run = this.down(BINDINGS.run)
      f.look = (this.down(BINDINGS.lookRight) ? 1 : 0) - (this.down(BINDINGS.lookLeft) ? 1 : 0)
      return
    }

    f.forward = 0
    f.strafe = 0
    f.run = false
    f.look = 0

    if (this.locked) {
      c.throttle = 0
      c.brake = 0
      c.steer = 0
      c.handbrake = false
      return
    }

    const useMouse = this.current === 'mouse'
    c.throttle = Math.max(this.down(BINDINGS.throttle) ? 1 : 0, useMouse && this.mouseButtons.has(LEFT_BUTTON) ? 1 : 0)
    c.brake = Math.max(this.down(BINDINGS.brake) ? 1 : 0, useMouse && this.mouseButtons.has(RIGHT_BUTTON) ? 1 : 0)
    // The keys win while they are held, so a keyboard correction always works in mouse mode.
    c.steer = keySteer !== 0 ? keySteer : useMouse ? this.cursorSteer() : 0
    c.handbrake = this.down(BINDINGS.handbrake)
  }

  /**
   * Moves the camera turning gathered from dragging with the right mouse button since the last call into
   * `out`, in pixels, and starts counting again. x is positive when the mouse moved right, and y when it
   * moved down.
   */
  takeLook(out: { x: number; y: number }): void {
    out.x = this.drag.x
    out.y = this.drag.y
    this.drag.x = 0
    this.drag.y = 0
  }

  /** True once per press of the reset key, then false until pressed again. Only queued while the keys control the car. */
  consumeReset(): boolean {
    const queued = this.resetQueued
    this.resetQueued = false
    return queued
  }

  /** True once per press of Enter, then false until pressed again. Only queued while the keys control the car. */
  consumeConfirm(): boolean {
    const queued = this.confirmQueued
    this.confirmQueued = false
    return queued
  }

  /** True once per press of the camera key, then false until pressed again. */
  consumeCamera(): boolean {
    const queued = this.cameraQueued
    this.cameraQueued = false
    return queued
  }

  /** True once per press of F, then false until pressed again. */
  consumeInteract(): boolean {
    const queued = this.interactQueued
    this.interactQueued = false
    return queued
  }

  /**
   * True once per press of Esc or P, then false until pressed again.
   * Poll this from the render hook, not the fixed step: the fixed step stops running while paused.
   */
  consumePause(): boolean {
    const queued = this.pauseQueued
    this.pauseQueued = false
    return queued
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('contextmenu', this.onContextMenu)
    document.documentElement.removeEventListener('mouseleave', this.onMouseLeave)
  }

  private down(codes: readonly string[]): boolean {
    return codes.some((code) => this.keys.has(code))
  }

  /** The cursor's horizontal position as steering: a dead zone in the middle, then a curve up to full lock. */
  private cursorSteer(): number {
    const { deadZone, fullLock, curve } = this.mouse
    const distance = Math.abs(this.mouseX)
    if (distance <= deadZone) return 0
    const t = clamp((distance - deadZone) / Math.max(fullLock - deadZone, 1e-3), 0, 1)
    return Math.sign(this.mouseX) * Math.pow(t, curve)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!BOUND_CODES.has(e.code)) return
    if (e.ctrlKey || e.metaKey || e.altKey) return // leave browser shortcuts (Ctrl+R, Ctrl+C) alone
    // A focused button or dropdown needs Space and Enter for itself. Only the pause keys get through.
    if (isInteractive(e.target) && !matches(BINDINGS.pause, e.code)) return
    e.preventDefault() // stops Space and the arrows from scrolling or clicking things
    this.keys.add(e.code)
    if (e.repeat) return
    const car = this.currentTarget === 'car'
    if (car && matches(BINDINGS.reset, e.code)) this.resetQueued = true
    if (car && matches(BINDINGS.confirm, e.code)) this.confirmQueued = true
    if (matches(BINDINGS.camera, e.code)) this.cameraQueued = true
    if (matches(BINDINGS.interact, e.code)) this.interactQueued = true
    if (matches(BINDINGS.pause, e.code)) this.pauseQueued = true
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
  }

  // The position is tracked in every mode, so switching to the mouse takes effect at once.
  private onMouseMove = (e: MouseEvent): void => {
    this.mouseX = clamp((e.clientX / Math.max(window.innerWidth, 1)) * 2 - 1, -1, 1)
    if (this.dragging) {
      this.drag.x += e.movementX
      this.drag.y += e.movementY
    }
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (isInteractive(e.target)) return // a click on a menu button isn't throttle or a camera drag
    if (this.currentTarget === 'foot') {
      if (e.button === RIGHT_BUTTON) {
        this.dragging = true
        e.preventDefault() // stops text selection and dragging while the camera turns
      }
      return
    }
    if (this.current !== 'mouse') return
    e.preventDefault() // stops text selection and dragging while a button is held
    this.mouseButtons.add(e.button)
  }

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === RIGHT_BUTTON) this.dragging = false
    this.mouseButtons.delete(e.button)
  }

  // A cursor that leaves the window stops at its last position, which could be full lock, so go straight instead.
  private onMouseLeave = (): void => {
    this.mouseX = 0
  }

  // Right-click is the brake in mouse mode and the camera drag on foot, so the browser's menu stays out of the way.
  private onContextMenu = (e: Event): void => {
    if ((this.current === 'mouse' || this.currentTarget === 'foot') && !isInteractive(e.target)) e.preventDefault()
  }

  // If the window loses focus mid-press, keyup never arrives and the car
  // would keep driving by itself. Clearing everything on blur prevents that.
  private onBlur = (): void => {
    this.keys.clear()
    this.mouseButtons.clear()
    this.mouseX = 0
    this.dragging = false
  }
}