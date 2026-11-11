import type { BestTimes } from '@/core/BestTimes'
import type { Updatable } from '@/core/Game'
import type { Input } from '@/core/Input'
import type { Car } from '@/entities/Car'
import type { LapResult, LapTracker } from '@/systems/LapTracker'

export type RaceState = 'menu' | 'countdown' | 'racing' | 'finished'

const COUNTDOWN_SECONDS = 3
const GO_BANNER_SECONDS = 1 // how long "GO!" stays up after the lights go out
const STOP_SPEED = 1 // m/s; below this the car is left to coast the rest of the way

export interface RaceControllerOptions {
  input: Input
  car: Car
  tracker: LapTracker
  bestTimes: BestTimes
  /** Puts the car back on the grid and snaps the camera. The controller resets the tracker afterwards. */
  respawn: () => void
}

export class RaceController implements Updatable {
  onStateChange: ((state: RaceState) => void) | null = null
  /** Fired with 3, 2, 1 as each number appears, then 0 at GO. */
  onCountdownTick: ((value: number) => void) | null = null
  onLap: ((result: LapResult) => void) | null = null
  onFinish: ((raceTime: number, lapTimes: readonly number[]) => void) | null = null

  readonly tracker: LapTracker

  private readonly input: Input
  private readonly car: Car
  private readonly bestTimes: BestTimes
  private readonly respawn: () => void

  private current: RaceState = 'menu'
  private countdown = 0 // seconds left until GO
  private lastTick = -1
  private goTimer = 0 // seconds left to show "GO!"

  constructor(options: RaceControllerOptions) {
    this.input = options.input
    this.car = options.car
    this.tracker = options.tracker
    this.bestTimes = options.bestTimes
    this.respawn = options.respawn

    // Start in the menu: car locked, and any saved best time loaded into the tracker.
    this.input.locked = true
    this.tracker.active = false
    this.tracker.bestLap = this.bestTimes.load()

    this.tracker.onLap = (result) => {
      if (result.isBest) this.bestTimes.submit(result.time)
      this.onLap?.(result)
    }
    this.tracker.onFinish = (raceTime) => {
      this.input.locked = true
      this.setState('finished')
      this.onFinish?.(raceTime, this.tracker.lapTimes)
    }
  }

  get state(): RaceState {
    return this.current
  }

  /** Big centre-screen text: the countdown number, "GO!", or an empty string. */
  get countdownText(): string {
    if (this.current === 'countdown') return String(Math.max(1, Math.ceil(this.countdown)))
    if (this.current === 'racing' && this.goTimer > 0) return 'GO!'
    return ''
  }

  /** Fixed-step update. Must run after Input and before the car. */
  update(dt: number): void {
    // Read both keys every step so a press made in another state doesn't linger.
    const reset = this.input.consumeReset()
    const confirm = this.input.consumeConfirm()

    if (reset && this.current !== 'menu') {
      this.restart()
      return
    }

    switch (this.current) {
      case 'menu':
        if (confirm) this.beginCountdown()
        break
      case 'countdown':
        this.updateCountdown(dt)
        break
      case 'racing':
        if (this.goTimer > 0) this.goTimer = Math.max(0, this.goTimer - dt)
        break
      case 'finished':
        this.brakeToStop()
        if (confirm) this.restart()
        break
    }
  }

  private restart(): void {
    this.respawn() // car back on the grid first, because tracker.reset() reads its position
    this.tracker.reset()
    this.beginCountdown()
  }

  private beginCountdown(): void {
    this.input.locked = true
    this.tracker.active = false
    this.countdown = COUNTDOWN_SECONDS
    this.lastTick = -1
    this.goTimer = 0
    this.setState('countdown')
  }

  private updateCountdown(dt: number): void {
    this.countdown -= dt
    const value = Math.max(0, Math.ceil(this.countdown))
    if (value !== this.lastTick) {
      this.lastTick = value
      if (value > 0) this.onCountdownTick?.(value)
    }
    if (this.countdown <= 0) this.go()
  }

  private go(): void {
    this.input.locked = false
    this.tracker.active = true
    this.goTimer = GO_BANNER_SECONDS
    this.setState('racing')
    this.onCountdownTick?.(0)
  }

  /**
   * After the finish the player's input is locked, so the controller brakes for them.
   * It only brakes while the car is moving forwards: braking at a standstill would
   * make the car reverse.
   */
  private brakeToStop(): void {
    const car = this.car
    const forwardSpeed =
      -Math.sin(car.heading) * car.velocity.x - Math.cos(car.heading) * car.velocity.z
    if (forwardSpeed > STOP_SPEED) this.input.controls.brake = 1
  }

  private setState(state: RaceState): void {
    if (this.current === state) return
    this.current = state
    this.onStateChange?.(state)
  }
}