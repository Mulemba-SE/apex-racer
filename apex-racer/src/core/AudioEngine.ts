const MASTER_VOLUME = 0.5
const ENGINE_VOLUME = 0.2
const SQUEAL_VOLUME = 0.8
const WIND_VOLUME = 0.25

const GEARS = 5
const IDLE_RPM = 0.18 // rpm is 0..1 here; 1 = redline
const SHIFT_RPM = 0.5 // where the revs drop to after each upshift
const IMPACT_GAP = 0.12 // seconds; stops a scrape along a wall from machine-gunning

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export interface AudioState {
  engineOn: boolean // false in the menu
  speedFraction: number // 0..1 of the car's top speed
  throttle: number // 0..1
  slip: number // sideways speed in m/s
}

interface Graph {
  ctx: AudioContext
  master: GainNode
  noise: AudioBuffer
  engineOsc: OscillatorNode
  engineOsc2: OscillatorNode
  engineFilter: BiquadFilterNode
  engineGain: GainNode
  squealFilter: BiquadFilterNode
  squealGain: GainNode
  windGain: GainNode
}

export class AudioEngine {
  private graph: Graph | null = null
  private muted = false
  private unavailable = false
  private lastImpactTime = -1
  private lastImpactSpeed = 0

  constructor() {
    // Browsers only allow audio after a key press or click, so the audio
    // graph is built on the first one. Pressing Enter in the menu does it.
    window.addEventListener('keydown', this.onGesture)
    window.addEventListener('pointerdown', this.onGesture)
    window.addEventListener('keydown', this.onKey)
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  get isMuted(): boolean {
    return this.muted
  }

  toggleMute(): void {
    this.muted = !this.muted
    const g = this.graph
    if (g) g.master.gain.setTargetAtTime(this.muted ? 0 : MASTER_VOLUME, g.ctx.currentTime, 0.02)
  }

  /** Call once per display frame. */
  update(s: AudioState): void {
    const g = this.graph
    if (!g) return
    const t = g.ctx.currentTime
    const on = s.engineOn

    // Engine: pick a gear from the speed, then place the revs inside it.
    const speed = clamp(s.speedFraction, 0, 1)
    const gear = Math.min(Math.floor(speed * GEARS), GEARS - 1)
    const within = speed * GEARS - gear
    let rpm = lerp(gear === 0 ? IDLE_RPM : SHIFT_RPM, 1, within)
    // Revving on the spot: throttle lifts the revs even at a standstill.
    rpm = Math.max(rpm, IDLE_RPM + s.throttle * 0.4 * (1 - clamp(speed * 8, 0, 1)))
    rpm *= 0.88 + 0.12 * s.throttle // revs sag slightly when you lift off

    const hz = lerp(48, 190, rpm)
    const load = 0.35 + 0.65 * s.throttle
    g.engineOsc.frequency.setTargetAtTime(hz, t, 0.05)
    g.engineOsc2.frequency.setTargetAtTime(hz * 2.01, t, 0.05)
    g.engineFilter.frequency.setTargetAtTime(lerp(350, 2600, rpm) * (0.6 + 0.4 * load), t, 0.08)
    g.engineGain.gain.setTargetAtTime(on ? ENGINE_VOLUME * load : 0, t, 0.08)

    // Tyre squeal: sideways slip beyond a threshold, and only when actually moving.
    const slip = Math.abs(s.slip)
    const squeal = on ? clamp((slip - 3.5) / 8, 0, 1) * clamp(speed * 6, 0, 1) : 0
    g.squealGain.gain.setTargetAtTime(squeal * SQUEAL_VOLUME, t, 0.04)
    g.squealFilter.frequency.setTargetAtTime(1200 + Math.min(slip, 15) * 55, t, 0.05)

    // Wind grows with the square of the speed.
    g.windGain.gain.setTargetAtTime(on ? speed * speed * WIND_VOLUME : 0, t, 0.1)
  }

  /** value is 3, 2, 1 for the countdown beeps and 0 for GO. */
  countdownTick(value: number): void {
    if (value > 0) this.tone(440, 0, 0.18, 'triangle', 0.35)
    else this.tone(880, 0, 0.6, 'triangle', 0.4)
  }

  lapChime(isBest: boolean): void {
    this.tone(659.25, 0, 0.3, 'sine', 0.35)
    this.tone(880, 0.09, 0.35, 'sine', 0.35)
    if (isBest) this.tone(1318.5, 0.18, 0.5, 'sine', 0.35)
  }

  finish(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5]
    notes.forEach((hz, i) => this.tone(hz, 0.4 + i * 0.12, 0.9, 'triangle', 0.3))
  }

  /** speed is how fast the car was moving into the wall, in m/s. */
  impact(speed: number): void {
    const g = this.graph
    if (!g) return
    const now = g.ctx.currentTime
    // Skip rapid repeats from a scrape, but always let a clearly harder hit through.
    if (now - this.lastImpactTime < IMPACT_GAP && speed < this.lastImpactSpeed * 1.5) return
    this.lastImpactTime = now
    this.lastImpactSpeed = speed

    const strength = clamp(speed / 25, 0.15, 1)

    // The crunch: a burst of noise whose brightness drops quickly.
    const src = g.ctx.createBufferSource()
    src.buffer = g.noise
    const filter = g.ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(2500, now)
    filter.frequency.exponentialRampToValueAtTime(200, now + 0.3)
    const crunch = g.ctx.createGain()
    crunch.gain.setValueAtTime(0.9 * strength, now)
    crunch.gain.exponentialRampToValueAtTime(0.001, now + 0.35)
    src.connect(filter).connect(crunch).connect(g.master)
    src.start(now)
    src.stop(now + 0.4)

    // The thump: a sine that drops in pitch.
    const osc = g.ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(110, now)
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.25)
    const thump = g.ctx.createGain()
    thump.gain.setValueAtTime(0.8 * strength, now)
    thump.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
    osc.connect(thump).connect(g.master)
    osc.start(now)
    osc.stop(now + 0.35)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onGesture)
    window.removeEventListener('pointerdown', this.onGesture)
    window.removeEventListener('keydown', this.onKey)
    document.removeEventListener('visibilitychange', this.onVisibility)
    const g = this.graph
    this.graph = null
    if (g) void g.ctx.close()
  }

  private readonly onGesture = (): void => {
    this.start()
    const ctx = this.graph?.ctx
    if (!ctx) return
    void ctx.resume().then(() => {
      // Once the context is really running, the gesture listeners have done their job.
      window.removeEventListener('keydown', this.onGesture)
      window.removeEventListener('pointerdown', this.onGesture)
    })
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.code === 'KeyM' && !e.repeat) this.toggleMute()
  }

  // The game loop stops in a background tab, which would leave the engine
  // droning at its last pitch, so the audio is paused too.
  private readonly onVisibility = (): void => {
    const ctx = this.graph?.ctx
    if (!ctx) return
    if (document.hidden) void ctx.suspend()
    else void ctx.resume()
  }

  private start(): void {
    if (this.graph || this.unavailable) return
    try {
      const ctx = new AudioContext()

      const master = ctx.createGain()
      master.gain.value = this.muted ? 0 : MASTER_VOLUME
      const compressor = ctx.createDynamicsCompressor() // keeps overlapping sounds from clipping
      master.connect(compressor).connect(ctx.destination)

      // Two seconds of white noise, shared by the squeal, wind and impacts.
      const length = Math.floor(ctx.sampleRate * 2)
      const noise = ctx.createBuffer(1, length, ctx.sampleRate)
      const data = noise.getChannelData(0)
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1

      // Engine: a sawtooth plus a quieter square an octave up, through a low-pass filter.
      const engineFilter = ctx.createBiquadFilter()
      engineFilter.type = 'lowpass'
      engineFilter.frequency.value = 600
      engineFilter.Q.value = 1.5
      const engineGain = ctx.createGain()
      engineGain.gain.value = 0
      engineFilter.connect(engineGain).connect(master)

      const engineOsc = ctx.createOscillator()
      engineOsc.type = 'sawtooth'
      engineOsc.frequency.value = 48
      engineOsc.connect(engineFilter)

      const engineOsc2 = ctx.createOscillator()
      engineOsc2.type = 'square'
      engineOsc2.frequency.value = 96
      const osc2Level = ctx.createGain()
      osc2Level.gain.value = 0.3
      engineOsc2.connect(osc2Level).connect(engineFilter)

      // Tyre squeal: noise squeezed through a narrow band-pass filter.
      const squealSrc = ctx.createBufferSource()
      squealSrc.buffer = noise
      squealSrc.loop = true
      const squealFilter = ctx.createBiquadFilter()
      squealFilter.type = 'bandpass'
      squealFilter.frequency.value = 1500
      squealFilter.Q.value = 8
      const squealGain = ctx.createGain()
      squealGain.gain.value = 0
      squealSrc.connect(squealFilter).connect(squealGain).connect(master)

      // Wind: soft low-passed noise, started part-way into the buffer so it differs from the squeal.
      const windSrc = ctx.createBufferSource()
      windSrc.buffer = noise
      windSrc.loop = true
      const windFilter = ctx.createBiquadFilter()
      windFilter.type = 'lowpass'
      windFilter.frequency.value = 700
      const windGain = ctx.createGain()
      windGain.gain.value = 0
      windSrc.connect(windFilter).connect(windGain).connect(master)

      engineOsc.start()
      engineOsc2.start()
      squealSrc.start()
      windSrc.start(0, 0.7)

      this.graph = {
        ctx,
        master,
        noise,
        engineOsc,
        engineOsc2,
        engineFilter,
        engineGain,
        squealFilter,
        squealGain,
        windGain,
      }
    } catch (error) {
      console.warn('Audio is unavailable:', error)
      this.unavailable = true
    }
  }

  private tone(freq: number, delay: number, duration: number, type: OscillatorType, volume: number): void {
    const g = this.graph
    if (!g) return
    const start = g.ctx.currentTime + delay
    const osc = g.ctx.createOscillator()
    osc.type = type
    osc.frequency.value = freq
    const env = g.ctx.createGain()
    env.gain.setValueAtTime(0.0001, start)
    env.gain.exponentialRampToValueAtTime(volume, start + 0.012)
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    osc.connect(env).connect(g.master)
    osc.start(start)
    osc.stop(start + duration + 0.05)
  }
}