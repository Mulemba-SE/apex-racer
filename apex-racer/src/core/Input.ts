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
  confirm: ['Enter', 'NumpadEnter'], // new: starts the race from the menu
} as const

const BOUND_CODES = new Set<string>(Object.values(BINDINGS).flat())

function matches(codes: readonly string[], code: string): boolean {
  return codes.includes(code)
}

export class Input {
  readonly controls: Controls = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
  }

  /**
   * New: while true, the car sees no input at all. Held keys are remembered, so
   * anything still held when the lock ends takes effect on the next step.
   */
  locked = false

  private readonly keys = new Set<string>()
  private resetQueued = false
  private confirmQueued = false // new

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

  /** New: true once per press of Enter, then false until pressed again. Works while locked. */
  consumeConfirm(): boolean {
    const queued = this.confirmQueued
    this.confirmQueued = false
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
    e.preventDefault() // stops Space and the arrows from scrolling or clicking things
    this.keys.add(e.code)
    if (e.repeat) return
    if (matches(BINDINGS.reset, e.code)) this.resetQueued = true
    if (matches(BINDINGS.confirm, e.code)) this.confirmQueued = true // new
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