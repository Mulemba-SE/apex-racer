import type { Updatable } from '@/core/Game'
import type { Car } from '@/entities/Car'
import type { TrackData } from '@/entities/TrackData'

const GATES_PER_LAP = 8 // gate 0 is the start/finish line; the others are checkpoints
const MAX_STEP = 20 // metres of progress in a single step; more than this is a glitch, so ignore it

export interface LapResult {
  lap: number // 1-based
  time: number // seconds
  isBest: boolean // true if this is the fastest lap so far (including any saved best)
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export class LapTracker implements Updatable {
  /** Fired when the car first crosses the start line and the clock starts. */
  onStart: (() => void) | null = null
  /** Fired at each checkpoint, with its number (1 to 7) and the time into the lap. */
  onCheckpoint: ((checkpoint: number, lapTime: number) => void) | null = null
  onLap: ((result: LapResult) => void) | null = null
  /** Fired after the final lap, with the total race time from the start line. */
  onFinish: ((raceTime: number) => void) | null = null

  totalLaps: number // 0 means no limit
  bestLap: number | null = null // seconds; set this from saved data before the race
  readonly lapTimes: number[] = []
  /** Time only runs while this is true. The race controller switches it on at GO. */
  active = false

  private readonly car: Car
  private readonly track: TrackData
  private readonly gateSpacing: number
  private index = -1 // nearest centre-line sample; also the search hint for the next step
  private lastDistance = 0
  private progress = 0 // metres from the start line, never wraps; negative before the line
  private elapsed = 0 // seconds since active
  private gate = 0 // the next gate to cross, counted across all laps
  private started = false
  private finished = false
  private lapStart = 0
  private raceStart = 0
  private finishTime = 0

  constructor(car: Car, track: TrackData, totalLaps = 3) {
    this.car = car
    this.track = track
    this.totalLaps = totalLaps
    this.gateSpacing = track.length / GATES_PER_LAP
    this.reset()
  }

  get isStarted(): boolean {
    return this.started
  }

  get isFinished(): boolean {
    return this.finished
  }

  get lapsCompleted(): number {
    return this.started ? Math.floor((this.gate - 1) / GATES_PER_LAP) : 0
  }

  /** The lap being driven, 1-based, never beyond the total. */
  get currentLap(): number {
    const lap = this.lapsCompleted + 1
    return this.totalLaps > 0 ? Math.min(lap, this.totalLaps) : lap
  }

  get currentLapTime(): number {
    if (!this.started) return 0
    if (this.finished) return this.lapTimes[this.lapTimes.length - 1] ?? 0
    return this.elapsed - this.lapStart
  }

  get raceTime(): number {
    if (this.finished) return this.finishTime
    return this.started ? this.elapsed - this.raceStart : 0
  }

  get lastLap(): number | null {
    return this.lapTimes[this.lapTimes.length - 1] ?? null
  }

  /** How far round the lap the car is, 0 to 1. Useful for the minimap and positions. */
  get lapFraction(): number {
    const L = this.track.length
    return (((this.progress % L) + L) % L) / L
  }

  update(dt: number): void {
    if (!this.active || this.finished) return
    const before = this.elapsed
    this.elapsed += dt

    const distance = this.measure()

    // Signed shortest distance travelled along the loop since the last step.
    const L = this.track.length
    let delta = distance - this.lastDistance
    if (delta > L / 2) delta -= L
    else if (delta < -L / 2) delta += L
    if (Math.abs(delta) > MAX_STEP) return // a glitch (a teleport, say): keep the old reference

    this.lastDistance = distance
    const prev = this.progress
    this.progress += delta

    // Cross every gate passed this step. That is normally none, and rarely more than one.
    while (!this.finished && this.progress >= this.gate * this.gateSpacing) {
      const target = this.gate * this.gateSpacing
      const span = this.progress - prev
      const fraction = span > 0 ? clamp((target - prev) / span, 0, 1) : 1
      this.crossGate(before + fraction * dt)
    }
  }

  /**
   * Puts the tracker back to "before the start line". Call this AFTER car.reset(),
   * because it reads the car's position to work out where on the track it is.
   */
  reset(): void {
    this.index = -1
    this.active = false
    this.started = false
    this.finished = false
    this.elapsed = 0
    this.lapStart = 0
    this.raceStart = 0
    this.finishTime = 0
    this.gate = 0
    this.lapTimes.length = 0

    const distance = this.measure()
    this.lastDistance = distance
    // A car just behind the line has progress -10, not a number near the full lap length.
    this.progress = distance > this.track.length / 2 ? distance - this.track.length : distance
  }

  /** Distance along the track of the car's position, refined to better than the 2 m sample spacing. */
  private measure(): number {
    const p = this.car.position
    this.index = this.track.nearestIndex(p.x, p.z, this.index)
    const s = this.track.sampleAt(this.index)
    const along = (p.x - s.position.x) * s.tangent.x + (p.z - s.position.z) * s.tangent.z
    return s.distance + along
  }

  private crossGate(time: number): void {
    const g = this.gate
    this.gate++

    if (g === 0) {
      this.started = true
      this.lapStart = time
      this.raceStart = time
      this.onStart?.()
      return
    }

    if (g % GATES_PER_LAP !== 0) {
      this.onCheckpoint?.(g % GATES_PER_LAP, time - this.lapStart)
      return
    }

    // A lap boundary.
    const lap = g / GATES_PER_LAP
    const lapTime = time - this.lapStart
    this.lapStart = time
    this.lapTimes.push(lapTime)

    const isBest = this.bestLap === null || lapTime < this.bestLap
    if (isBest) this.bestLap = lapTime
    this.onLap?.({ lap, time: lapTime, isBest })

    if (this.totalLaps > 0 && lap >= this.totalLaps) {
      this.finished = true
      this.finishTime = time - this.raceStart
      this.onFinish?.(this.finishTime)
    }
  }
}