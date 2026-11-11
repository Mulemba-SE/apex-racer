export interface LoopCallbacks {
  update: (dt: number) => void
  render: (alpha: number, frameDt: number) => void
}

export class GameLoop {
  readonly step = 1 / 60
  private readonly maxFrameTime = 0.1 // clamp so a long stall can't cause a spiral
  private accumulator = 0
  private last = 0
  private running = false
  private rafId = 0
  private readonly callbacks: LoopCallbacks

  
  constructor(callbacks: LoopCallbacks) {
    this.callbacks = callbacks
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    this.rafId = requestAnimationFrame(this.frame)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.rafId)
  }

  private frame = (now: number): void => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.frame)

    const frameDt = Math.min((now - this.last) / 1000, this.maxFrameTime)
    this.last = now
    this.accumulator += frameDt

    while (this.accumulator >= this.step) {
      this.callbacks.update(this.step)
      this.accumulator -= this.step
    }

    this.callbacks.render(this.accumulator / this.step, frameDt)
  }
}