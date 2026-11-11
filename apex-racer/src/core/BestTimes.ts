const PREFIX = 'apex-racer:best-lap:'

/** Turns a track name into a safe storage key, e.g. "Circuit One" -> "circuit-one". */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export class BestTimes {
  private readonly key: string
  private cached: number | null = null // also serves as the fallback when storage is blocked

  constructor(trackName: string) {
    this.key = PREFIX + slug(trackName)
    this.cached = this.read()
  }

  /** Best lap in seconds, or null if no lap has been saved yet. */
  load(): number | null {
    return this.cached
  }

  /**
   * Saves `time` if it beats the stored best. Returns true when it did, so the
   * caller can show a "new best" message.
   */
  submit(time: number): boolean {
    if (!Number.isFinite(time) || time <= 0) return false
    if (this.cached !== null && time >= this.cached) return false
    this.cached = time
    this.write(time)
    return true
  }

  /** Forgets the saved best. */
  clear(): void {
    this.cached = null
    try {
      localStorage.removeItem(this.key)
    } catch {
      // Storage is unavailable; there is nothing to remove.
    }
  }

  private read(): number | null {
    try {
      const raw = localStorage.getItem(this.key)
      if (raw === null) return null
      const value = Number.parseFloat(raw)
      // Ignore anything that isn't a plausible lap time (edited by hand, or corrupted).
      return Number.isFinite(value) && value > 0 && value < 3600 ? value : null
    } catch {
      return null
    }
  }

  private write(time: number): void {
    try {
      localStorage.setItem(this.key, String(time))
    } catch {
      // Storage is full or blocked; the best time still lasts for this session.
    }
  }
}