export interface Controls {
  throttle: number // 0..1
  brake: number // 0..1
  steer: number // -1 (left) .. 1 (right)
  handbrake: boolean
}

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

function matches(codes: readonly string[], code: string): boolean {
  return codes.includes(code)
}

/** True when a key press is aimed at a button, dropdown or text field, which needs its keys for itself. */
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
   * While true, the car sees no input at all. Held keys are remembered, so
   * anything still held when the lock ends takes effect on the next step.
   */
  locked = false

  private readonly keys = new Set<string>()
  private resetQueued = false
  private confirmQueued = false
  private cameraQueued = false
  private pauseQueued = false

  constructor() {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  /** Samples the held keys into `controls`. Call once per fixed step. */
  update(_dt: number): void {
    const c = this.controls
    if (this.locked) {
      c.throttle = 0
      c.brake = 0
      c.steer = 0
      c.handbrake = false
      return
    }
    c.throttle = this.down(BINDINGS.throttle) ? 1 : 0
    c.brake = this.down(BINDINGS.brake) ? 1 : 0
    c.steer = (this.down(BINDINGS.right) ? 1 : 0) - (this.down(BINDINGS.left) ? 1 : 0)
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
  }

  private down(codes: readonly string[]): boolean {
    return codes.some((code) => this.keys.has(code))
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

  // If the window loses focus mid-press, keyup never arrives and the car
  // would keep driving by itself. Clearing everything on blur prevents that.
  private onBlur = (): void => {
    this.keys.clear()
  }
}