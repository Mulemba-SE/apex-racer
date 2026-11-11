import type { RaceState } from '@/core/RaceController'

export interface HudData {
  state: RaceState
  countdownText: string // "3", "2", "1", "GO!" or ""
  lap: number // 1-based
  totalLaps: number // 0 means no limit
  lapTime: number // seconds
  lastLap: number | null
  bestLap: number | null
  raceTime: number // seconds
  speedKmh: number
  speedFraction: number // 0..1 of the car's top speed
}

export function formatTime(seconds: number | null): string {
  if (seconds === null) return '-:--.---'
  const ms = Math.round(Math.max(0, seconds) * 1000)
  const minutes = Math.floor(ms / 60000)
  const rest = (ms % 60000) / 1000
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`
}

const CSS = `
.hud-root { position: absolute; inset: 0; font-variant-numeric: tabular-nums; }
.hud-panel {
  position: absolute;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(10, 12, 18, 0.55);
  backdrop-filter: blur(4px);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
.hud-lap { top: 12px; right: 12px; min-width: 200px; }
.hud-row { display: flex; justify-content: space-between; align-items: baseline; gap: 18px; line-height: 1.55; }
.hud-label { font-size: 12px; letter-spacing: 0.1em; opacity: 0.65; }
.hud-value { font: 600 18px ui-monospace, monospace; }
.hud-best .hud-value { color: #c4a3ff; }
.hud-speed { right: 12px; bottom: 12px; min-width: 190px; text-align: right; }
.hud-speed-num { font: 800 58px/1 system-ui; }
.hud-speed-unit { font-size: 13px; letter-spacing: 0.12em; opacity: 0.65; }
.hud-bar { height: 6px; margin-top: 8px; border-radius: 3px; background: rgba(255, 255, 255, 0.18); overflow: hidden; }
.hud-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #4cd964, #ffd60a, #ff453a);
  clip-path: inset(0 100% 0 0);
}
.hud-banner { position: absolute; top: 22%; left: 0; width: 100%; text-align: center; text-shadow: 0 2px 10px rgba(0, 0, 0, 0.7); }
.hud-title { font: 800 84px/1.1 system-ui; letter-spacing: 0.02em; }
.hud-sub { margin-top: 6px; font: 600 20px/1.6 system-ui; white-space: pre-line; }
.hud-toast { position: absolute; top: 60%; left: 0; width: 100%; text-align: center; opacity: 0; text-shadow: 0 2px 8px rgba(0, 0, 0, 0.7); }
.hud-toast-main { font: 700 34px/1.2 ui-monospace, monospace; }
.hud-toast-tag { margin-top: 4px; font: 800 20px/1.2 system-ui; letter-spacing: 0.12em; color: #c4a3ff; }
`

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  parent?.appendChild(node)
  return node
}

function addRow(parent: HTMLElement, label: string, extraClass = ''): HTMLElement {
  const row = el('div', `hud-row ${extraClass}`.trim(), parent)
  el('span', 'hud-label', row, label)
  return el('span', 'hud-value', row, '')
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text // avoids touching the page when nothing changed
}

export class Hud {
  private readonly root: HTMLDivElement
  private readonly style: HTMLStyleElement

  private readonly lapValue: HTMLElement
  private readonly timeValue: HTMLElement
  private readonly lastValue: HTMLElement
  private readonly bestValue: HTMLElement
  private readonly speedNum: HTMLElement
  private readonly barFill: HTMLElement
  private readonly title: HTMLElement
  private readonly sub: HTMLElement
  private readonly toast: HTMLElement
  private readonly toastMain: HTMLElement
  private readonly toastTag: HTMLElement

  private toastAnimation: Animation | null = null
  private lastTitle = ''
  private lastBar = -1

  constructor(container: HTMLElement) {
    this.style = document.createElement('style')
    this.style.textContent = CSS
    document.head.appendChild(this.style)

    this.root = el('div', 'hud-root', container)

    // Lap panel, top right.
    const lapPanel = el('div', 'hud-panel hud-lap', this.root)
    this.lapValue = addRow(lapPanel, 'LAP')
    this.timeValue = addRow(lapPanel, 'TIME')
    this.lastValue = addRow(lapPanel, 'LAST')
    this.bestValue = addRow(lapPanel, 'BEST', 'hud-best')

    // Speedometer, bottom right.
    const speedPanel = el('div', 'hud-panel hud-speed', this.root)
    this.speedNum = el('div', 'hud-speed-num', speedPanel, '0')
    el('div', 'hud-speed-unit', speedPanel, 'KM/H')
    const bar = el('div', 'hud-bar', speedPanel)
    this.barFill = el('div', 'hud-bar-fill', bar)

    // Banner: countdown, GO, menu and finish text.
    const banner = el('div', 'hud-banner', this.root)
    this.title = el('div', 'hud-title', banner)
    this.sub = el('div', 'hud-sub', banner)

    // Lap-time toast, shown briefly after each lap.
    this.toast = el('div', 'hud-toast', this.root)
    this.toastMain = el('div', 'hud-toast-main', this.toast)
    this.toastTag = el('div', 'hud-toast-tag', this.toast)
  }

  /** Call once per display frame with the current game values. */
  update(d: HudData): void {
    const total = d.totalLaps > 0 ? ` / ${d.totalLaps}` : ''
    setText(this.lapValue, d.state === 'menu' ? `-${total}` : `${d.lap}${total}`)
    setText(this.timeValue, formatTime(d.lapTime))
    setText(this.lastValue, formatTime(d.lastLap))
    setText(this.bestValue, formatTime(d.bestLap))

    setText(this.speedNum, String(Math.max(0, Math.round(d.speedKmh))))
    const pct = Math.round(Math.min(1, Math.max(0, d.speedFraction)) * 100)
    if (pct !== this.lastBar) {
      this.lastBar = pct
      this.barFill.style.clipPath = `inset(0 ${100 - pct}% 0 0)` // keeps the gradient fixed while the bar grows
    }

    let title = ''
    let sub = ''
    switch (d.state) {
      case 'menu':
        title = 'APEX RACER'
        sub = 'Press ENTER to start\nW/S throttle and brake   A/D steer   SPACE handbrake   R restart'
        break
      case 'countdown':
      case 'racing':
        title = d.countdownText
        break
      case 'finished':
        title = 'FINISH'
        sub =
          `Race ${formatTime(d.raceTime)}   Best lap ${formatTime(d.bestLap)}\n` +
          'Press ENTER to race again'
        break
    }
    setText(this.sub, sub)
    if (title !== this.lastTitle) {
      this.lastTitle = title
      this.title.textContent = title
      if (title !== '') this.popTitle()
    }
  }

  /** Shows the lap time for a few seconds, with a "new best" tag when it is one. */
  showLapToast(lap: number, time: number, isBest: boolean): void {
    this.toastMain.textContent = `LAP ${lap}   ${formatTime(time)}`
    this.toastTag.textContent = isBest ? 'NEW BEST LAP' : ''
    this.toastTag.style.display = isBest ? 'block' : 'none'
    this.toastAnimation?.cancel()
    this.toastAnimation = this.toast.animate(
      [
        { opacity: 0, transform: 'translateY(-12px)', offset: 0 },
        { opacity: 1, transform: 'translateY(0)', offset: 0.08 },
        { opacity: 1, transform: 'translateY(0)', offset: 0.8 },
        { opacity: 0, transform: 'translateY(0)', offset: 1 },
      ],
      { duration: 3500, fill: 'forwards' },
    )
  }

  dispose(): void {
    this.toastAnimation?.cancel()
    this.root.remove()
    this.style.remove()
  }

  private popTitle(): void {
    this.title.animate(
      [
        { transform: 'scale(1.35)', opacity: 0 },
        { transform: 'scale(1)', opacity: 1 },
      ],
      { duration: 220, easing: 'ease-out' },
    )
  }
}