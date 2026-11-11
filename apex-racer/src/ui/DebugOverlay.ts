import type { WebGLInfo } from 'three'

export class DebugOverlay {
  private readonly el = document.createElement('pre')
  private visible = true
  private frames = 0
  private elapsed = 0

  constructor() {
    Object.assign(this.el.style, {
      position: 'fixed',
      top: '8px',
      left: '8px',
      margin: '0',
      padding: '6px 8px',
      font: '12px/1.4 ui-monospace, monospace',
      color: '#7CFC00',
      background: 'rgba(0, 0, 0, 0.55)',
      pointerEvents: 'none',
      zIndex: '10',
      whiteSpace: 'pre',
    })
    document.body.appendChild(this.el)
    window.addEventListener('keydown', this.onKey)
  }

  update(frameDt: number, info: WebGLInfo): void {
    this.frames++
    this.elapsed += frameDt
    if (this.elapsed < 0.5) return // refresh twice a second so it stays readable

    const fps = this.frames / this.elapsed
    this.el.textContent =
      `${fps.toFixed(0)} FPS (${(1000 / fps).toFixed(1)} ms)\n` +
      `draw calls ${info.render.calls}\n` +
      `triangles  ${info.render.triangles}\n` +
      `[F3] toggle`
    this.frames = 0
    this.elapsed = 0
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey)
    this.el.remove()
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'F3') return
    e.preventDefault()
    this.visible = !this.visible
    this.el.style.display = this.visible ? 'block' : 'none'
  }
}