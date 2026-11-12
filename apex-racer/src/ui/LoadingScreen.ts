const CSS = `
.loading-root {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  background: radial-gradient(ellipse at center, #1c2230 0%, #0a0c12 75%);
  color: #fff;
  font-family: system-ui, sans-serif;
  transition: opacity 0.4s ease;
}
.loading-root.loading-hidden { opacity: 0; pointer-events: none; }
.loading-title { font: 800 56px/1.1 system-ui; letter-spacing: 0.04em; }
.loading-bar {
  width: min(320px, 70vw);
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.15);
  overflow: hidden;
}
.loading-fill {
  height: 100%;
  width: 100%;
  background: linear-gradient(90deg, #4cd964, #ffd60a);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 0.2s ease-out;
}
.loading-fill.loading-indeterminate {
  width: 40%;
  transform: none;
  transition: none;
  animation: loading-slide 1.1s ease-in-out infinite;
}
.loading-status { font: 600 14px/1.4 system-ui; letter-spacing: 0.08em; opacity: 0.7; }
@keyframes loading-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}
@media (prefers-reduced-motion: reduce) {
  .loading-fill.loading-indeterminate { animation: none; width: 100%; opacity: 0.5; }
}
`

export class LoadingScreen {
  private readonly root: HTMLDivElement
  private readonly style: HTMLStyleElement
  private readonly fill: HTMLDivElement
  private readonly status: HTMLDivElement
  private hiding: Promise<void> | null = null

  constructor(container: HTMLElement = document.body) {
    this.style = document.createElement('style')
    this.style.textContent = CSS
    document.head.appendChild(this.style)

    this.root = document.createElement('div')
    this.root.className = 'loading-root'

    const title = document.createElement('div')
    title.className = 'loading-title'
    title.textContent = 'APEX RACER'

    const bar = document.createElement('div')
    bar.className = 'loading-bar'
    this.fill = document.createElement('div')
    this.fill.className = 'loading-fill loading-indeterminate' // until real progress arrives
    bar.appendChild(this.fill)

    this.status = document.createElement('div')
    this.status.className = 'loading-status'
    this.status.textContent = 'LOADING'

    this.root.append(title, bar, this.status)
    container.appendChild(this.root)
  }

  /** 0 to 1, or null when the size of the download isn't known. */
  setProgress(fraction: number | null): void {
    if (fraction === null) {
      this.fill.classList.add('loading-indeterminate')
      this.fill.style.transform = ''
      return
    }
    this.fill.classList.remove('loading-indeterminate')
    const clamped = Math.min(1, Math.max(0, fraction))
    this.fill.style.transform = `scaleX(${clamped})`
  }

  setStatus(text: string): void {
    if (this.status.textContent !== text) this.status.textContent = text
  }

  /** Fades the screen out and removes it. Safe to call more than once. The promise resolves when it is gone. */
  hide(): Promise<void> {
    if (this.hiding) return this.hiding
    this.hiding = new Promise<void>((resolve) => {
      this.setProgress(1)
      this.root.classList.add('loading-hidden')
      // transitionend can be skipped (a background tab, reduced motion), so a timer is the backstop.
      window.setTimeout(() => {
        this.dispose()
        resolve()
      }, 450)
    })
    return this.hiding
  }

  dispose(): void {
    this.root.remove()
    this.style.remove()
  }
}