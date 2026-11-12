import type { Updatable } from '@/core/Game'
import type { Car } from '@/entities/Car'
import type { TrackData } from '@/entities/TrackData'

const MAX_STEP = 20 // metres of progress in a single step; more than this is a glitch, so ignore it

interface Entry {
  car: Car
  index: number // nearest centre-line sample; also the search hint for the next step
  lastDistance: number
  progress: number // metres from the start line, never wraps; negative before the line
  finishTime: number | null // seconds on the race clock, once the car has completed every lap
  rank: number // 1-based
}

export class Standings implements Updatable {
  /** The race clock and every car's progress only run while this is true. */
  active = false

  private readonly track: TrackData
  private readonly finishDistance: number // Infinity when there is no lap limit
  private readonly entries: Entry[]
  private readonly order: Entry[] // the same entries, sorted by position
  private readonly byCar = new Map<Car, Entry>()
  private elapsed = 0

  /** Cars should be on their grid slots when this is created. totalLaps = 0 means no limit. */
  constructor(cars: readonly Car[], track: TrackData, totalLaps: number) {
    this.track = track
    this.finishDistance = totalLaps > 0 ? totalLaps * track.length : Infinity
    this.entries = cars.map((car) => ({
      car,
      index: -1,
      lastDistance: 0,
      progress: 0,
      finishTime: null,
      rank: 0,
    }))
    for (const entry of this.entries) this.byCar.set(entry.car, entry)
    this.order = [...this.entries]
    this.reset()
  }

  get count(): number {
    return this.entries.length
  }

  /** A car's current position, 1 for the leader. Returns 0 for a car that isn't in the race. */
  positionOf(car: Car): number {
    return this.byCar.get(car)?.rank ?? 0
  }

  isFinished(car: Car): boolean {
    return this.byCar.get(car)?.finishTime != null
  }

  update(dt: number): void {
    if (!this.active) return
    const before = this.elapsed
    this.elapsed += dt
    const L = this.track.length

    for (const e of this.entries) {
      if (e.finishTime !== null) continue // a finished car's place no longer changes

      const distance = this.measure(e)

      // Signed shortest distance travelled along the loop since the last step.
      let delta = distance - e.lastDistance
      if (delta > L / 2) delta -= L
      else if (delta < -L / 2) delta += L
      if (Math.abs(delta) > MAX_STEP) continue // a glitch (a teleport, say): keep the old reference

      e.lastDistance = distance
      const previous = e.progress
      e.progress += delta

      if (e.progress >= this.finishDistance) {
        const span = e.progress - previous
        const fraction = span > 0 ? (this.finishDistance - previous) / span : 1
        e.finishTime = before + Math.min(1, Math.max(0, fraction)) * dt
      }
    }

    this.rank()
  }

  /**
   * Puts every car back to "before the start line". Call this AFTER the cars have
   * been placed on the grid, because it reads their positions.
   */
  reset(): void {
    this.active = false
    this.elapsed = 0
    const L = this.track.length
    for (const e of this.entries) {
      e.index = -1
      e.finishTime = null
      const distance = this.measure(e)
      e.lastDistance = distance
      // A car just behind the line has progress -10, not a number near the full lap length.
      e.progress = distance > L / 2 ? distance - L : distance
    }
    this.rank()
  }

  /** Distance along the track of a car's position, refined to better than the 2 m sample spacing. */
  private measure(e: Entry): number {
    const p = e.car.position
    e.index = this.track.nearestIndex(p.x, p.z, e.index)
    const s = this.track.sampleAt(e.index)
    const along = (p.x - s.position.x) * s.tangent.x + (p.z - s.position.z) * s.tangent.z
    return s.distance + along
  }

  private readonly compare = (a: Entry, b: Entry): number => {
    if (a.finishTime !== null && b.finishTime !== null) return a.finishTime - b.finishTime
    if (a.finishTime !== null) return -1 // finished cars are ahead of unfinished ones
    if (b.finishTime !== null) return 1
    return b.progress - a.progress // further round the track is ahead
  }

  private rank(): void {
    this.order.sort(this.compare) // the sort is stable, so cars level on progress keep their order
    this.order.forEach((e, i) => {
      e.rank = i + 1
    })
  }
}