export type Quality = 'low' | 'medium' | 'high'

export const QUALITIES: readonly Quality[] = ['low', 'medium', 'high']

export interface QualityPreset {
  pixelRatio: number // the most device pixels per CSS pixel the renderer will draw
  shadowMapSize: number // pixels per side of the sun's shadow map
  smokeDensity: number // 0..1, how much of the tyre smoke and dust is made
}

export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  low: { pixelRatio: 1, shadowMapSize: 1024, smokeDensity: 0.4 },
  medium: { pixelRatio: 1.5, shadowMapSize: 1024, smokeDensity: 0.7 },
  high: { pixelRatio: 2, shadowMapSize: 2048, smokeDensity: 1 },
}

export const QUALITY_LABELS: Record<Quality, string> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
}

const STORAGE_KEY = 'apex-racer:settings'

function isQuality(value: unknown): value is Quality {
  return typeof value === 'string' && (QUALITIES as readonly string[]).includes(value)
}

/** The first-run choice: a phone or a small laptop starts on medium, anything else on high. */
function defaultQuality(): Quality {
  const touch = window.matchMedia('(pointer: coarse)').matches
  const cores = navigator.hardwareConcurrency || 8
  return touch || cores <= 4 ? 'medium' : 'high'
}

export class Settings {
  private current: Quality
  private readonly listeners = new Set<(settings: Settings) => void>()

  constructor() {
    this.current = this.read() ?? defaultQuality()
  }

  get quality(): Quality {
    return this.current
  }

  get preset(): QualityPreset {
    return QUALITY_PRESETS[this.current]
  }

  setQuality(quality: Quality): void {
    if (quality === this.current) return
    this.current = quality
    this.write()
    for (const listener of this.listeners) listener(this)
  }

  /** Moves to the next quality level, wrapping from high back to low, and returns it. */
  cycleQuality(): Quality {
    const next = QUALITIES[(QUALITIES.indexOf(this.current) + 1) % QUALITIES.length]!
    this.setQuality(next)
    return next
  }

  /** Calls `listener` whenever the settings change. Returns a function that stops it. */
  onChange(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private read(): Quality | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw === null) return null
      const data: unknown = JSON.parse(raw)
      if (typeof data !== 'object' || data === null) return null
      const quality = (data as { quality?: unknown }).quality
      return isQuality(quality) ? quality : null // anything unexpected counts as "not saved"
    } catch {
      return null // storage blocked or the text isn't valid JSON
    }
  }

  private write(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ quality: this.current }))
    } catch {
      // Storage is full or blocked; the setting still applies for this session.
    }
  }
}