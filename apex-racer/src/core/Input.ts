export interface Controls {
  throttle: number // 0..1
  brake: number // 0..1
  steer: number // -1 (left) .. 1 (right)
  handbrake: boolean
}

/** How the car is steered. 'mouse' adds the cursor and mouse buttons; the keyboard always works too. */
export type ControlScheme = 'keyboard' | 'mouse'

export const CONTROL_SCHEMES: readonly ControlScheme[] = ['keyboard', 'mouse']

// KeyboardEvent.code is the physical key position, so WASD keeps working
// on non-QWERTY layouts.
const BINDINGS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  reset: ['KeyR'],
  confirm: ['Enter', 'NumpadEnter'], // starts the race from the menu
  camera: ['KeyC'], // cycles the camera view
  pause: ['Escape', 'KeyP'], // pauses and resumes
} as const

const BOUND_CODES = new Set<string>(Object.values(BINDINGS).flat())

const LEFT_BUTTON = 0 // MouseEvent.button: throttle in mouse mode
const RIGHT_BUTTON = 2 // brake in mouse mode

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
   * While true, the car sees no input at all. Held keys are remembered, so
   * anything still held when the lock ends takes effect on the next step.
   */
  locked = false

  private current: ControlScheme = 'keyboard'
  private mouseX = 0 // the cursor's horizontal position, -1 (left edge) to 1 (right edge)
  private readonly mouseButtons = new Set<number>()
  private readonly keys = new Set<string>()
  private resetQueued = false
  private confirmQueued = false
  private cameraQueued = false
  private pauseQueued = false

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

  /** Samples the held keys and the mouse into `controls`. Call once per fixed step. */
  update(_dt: number): void {
    const c = this.controls
    if (this.locked) {
      c.throttle = 0
      c.brake = 0
      c.steer = 0
      c.handbrake = false
      return
    }

    const useMouse = this.current === 'mouse'
    const keySteer = (this.down(BINDINGS.right) ? 1 : 0) - (this.down(BINDINGS.left) ? 1 : 0)

    c.throttle = Math.max(this.down(BINDINGS.throttle) ? 1 : 0, useMouse && this.mouseButtons.has(LEFT_BUTTON) ? 1 : 0)
    c.brake = Math.max(this.down(BINDINGS.brake) ? 1 : 0, useMouse && this.mouseButtons.has(RIGHT_BUTTON) ? 1 : 0)
    // The keys win while they are held, so a keyboard correction always works in mouse mode.
    c.steer = keySteer !== 0 ? keySteer : useMouse ? this.cursorSteer() : 0
    c.handbrake = this.down(BINDINGS.handbrake)
  }

  /** True once per press of the reset key, then false until pressed again. Works while locked. */
  consumeReset(): boolean {
    const queued = this.resetQueued
    this.resetQueued = false
    return queued
  }

  /** True once per press of Enter, then false until pressed again. Works while locked. */
  consumeConfirm(): boolean {
    const queued = this.confirmQueued
    this.confirmQueued = false
    return queued
  }

  /** True once per press of the camera key, then false until pressed again. Works while locked. */
  consumeCamera(): boolean {
    const queued = this.cameraQueued
    this.cameraQueued = false
    return queued
  }

  /**
   * True once per press of Esc or P, then false until pressed again. Works while locked.
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
    if (matches(BINDINGS.reset, e.code)) this.resetQueued = true
    if (matches(BINDINGS.confirm, e.code)) this.confirmQueued = true
    if (matches(BINDINGS.camera, e.code)) this.cameraQueued = true
    if (matches(BINDINGS.pause, e.code)) this.pauseQueued = true
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
  }

  // The position is tracked in every mode, so switching to the mouse takes effect at once.
  private onMouseMove = (e: MouseEvent): void => {
    this.mouseX = clamp((e.clientX / Math.max(window.innerWidth, 1)) * 2 - 1, -1, 1)
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (this.current !== 'mouse' || isInteractive(e.target)) return // a click on a menu button isn't throttle
    e.preventDefault() // stops text selection and dragging while a button is held
    this.mouseButtons.add(e.button)
  }

  private onMouseUp = (e: MouseEvent): void => {
    this.mouseButtons.delete(e.button)
  }

  // A cursor that leaves the window stops at its last position, which could be full lock, so go straight instead.
  private onMouseLeave = (): void => {
    this.mouseX = 0
  }

  // Right-click is the brake in mouse mode, so the browser's menu stays out of the way.
  private onContextMenu = (e: Event): void => {
    if (this.current === 'mouse' && !isInteractive(e.target)) e.preventDefault()
  }

  // If the window loses focus mid-press, keyup never arrives and the car
  // would keep driving by itself. Clearing everything on blur prevents that.
  private onBlur = (): void => {
    this.keys.clear()
    this.mouseButtons.clear()
    this.mouseX = 0
  }
}