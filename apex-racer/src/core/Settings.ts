import type { ControlScheme } from '@/core/Input'
import { CONTROL_SCHEMES } from '@/core/Input'

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

export const CONTROL_LABELS: Record<ControlScheme, string> = {
  keyboard: 'KEYBOARD',
  mouse: 'MOUSE',
}

const STORAGE_KEY = 'apex-racer:settings'

function isQuality(value: unknown): value is Quality {
  return typeof value === 'string' && (QUALITIES as readonly string[]).includes(value)
}

function isControlScheme(value: unknown): value is ControlScheme {
  return typeof value === 'string' && (CONTROL_SCHEMES as readonly string[]).includes(value)
}

/** The first-run choice: a phone or a small laptop starts on medium, anything else on high. */
function defaultQuality(): Quality {
  const touch = window.matchMedia('(pointer: coarse)').matches
  const cores = navigator.hardwareConcurrency || 8
  return touch || cores <= 4 ? 'medium' : 'high'
}

/** What was found in storage. A value that is missing or not recognised is null. */
interface Saved {
  quality: Quality | null
  controls: ControlScheme | null
}

export class Settings {
  private currentQuality: Quality
  private currentControls: ControlScheme
  private readonly listeners = new Set<(settings: Settings) => void>()

  constructor() {
    const saved = this.read()
    this.currentQuality = saved.quality ?? defaultQuality()
    this.currentControls = saved.controls ?? 'keyboard' // the mouse is always something the player chooses
  }

  get quality(): Quality {
    return this.currentQuality
  }

  get preset(): QualityPreset {
    return QUALITY_PRESETS[this.currentQuality]
  }

  /** How the car is steered: 'keyboard' or 'mouse'. */
  get controlScheme(): ControlScheme {
    return this.currentControls
  }

  setQuality(quality: Quality): void {
    if (quality === this.currentQuality) return
    this.currentQuality = quality
    this.write()
    this.notify()
  }

  setControlScheme(scheme: ControlScheme): void {
    if (scheme === this.currentControls) return
    this.currentControls = scheme
    this.write()
    this.notify()
  }

  /** Moves to the next quality level, wrapping from high back to low, and returns it. */
  cycleQuality(): Quality {
    const next = QUALITIES[(QUALITIES.indexOf(this.currentQuality) + 1) % QUALITIES.length]!
    this.setQuality(next)
    return next
  }

  /** Calls `listener` whenever any setting changes. Returns a function that stops it. */
  onChange(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this)
  }

  private read(): Saved {
    const nothing: Saved = { quality: null, controls: null }
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw === null) return nothing
      const data: unknown = JSON.parse(raw)
      if (typeof data !== 'object' || data === null) return nothing
      const { quality, controls } = data as { quality?: unknown; controls?: unknown }
      // Each value is checked on its own, so one bad entry doesn't lose the other.
      return {
        quality: isQuality(quality) ? quality : null,
        controls: isControlScheme(controls) ? controls : null,
      }
    } catch {
      return nothing // storage blocked or the text isn't valid JSON
    }
  }

  private write(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ quality: this.currentQuality, controls: this.currentControls }),
      )
    } catch {
      // Storage is full or blocked; the settings still apply for this session.
    }
  }
}