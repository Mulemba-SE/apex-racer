import { QUALITIES, QUALITY_LABELS, type Quality } from '@/core/Settings'

export interface PauseMenuOptions {
  quality: Quality // the quality shown as selected
  onResume: () => void
  onRestart: () => void
  onQuality: (quality: Quality) => void
}

const CSS = `
.pause-root {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(6, 8, 14, 0.6);
  backdrop-filter: blur(6px);
  color: #fff;
  font-family: system-ui, sans-serif;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.15s ease, visibility 0.15s;
}
.pause-root.pause-open { opacity: 1; visibility: visible; }
.pause-card {
  width: min(380px, 90vw);
  box-sizing: border-box;
  padding: 28px 28px 22px;
  border-radius: 16px;
  background: rgba(20, 24, 34, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.pause-title { font: 800 34px/1 system-ui; letter-spacing: 0.06em; text-align: center; }
.pause-label { margin-bottom: 8px; font: 600 12px system-ui; letter-spacing: 0.12em; opacity: 0.6; }
.pause-quality { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.pause-btn {
  appearance: none;
  padding: 11px 10px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  font: 700 14px system-ui;
  letter-spacing: 0.08em;
  cursor: pointer;
}
.pause-btn:hover { background: rgba(255, 255, 255, 0.14); }
.pause-btn:focus-visible { outline: 2px solid #ffd60a; outline-offset: 2px; }
.pause-btn[aria-checked="true"] { background: #ffd60a; border-color: #ffd60a; color: #14161c; }
.pause-primary { background: #4cd964; border-color: #4cd964; color: #0b1a0f; font-size: 16px; }
.pause-primary:hover { background: #6ae27d; }
.pause-keys {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 14px;
  margin: 0;
  font: 500 13px system-ui;
  opacity: 0.85;
}
.pause-keys dt { font: 700 12px ui-monospace, monospace; opacity: 0.9; }
.pause-keys dd { margin: 0; }
@media (prefers-reduced-motion: reduce) {
  .pause-root { transition: none; }
}
`

const KEYS: readonly (readonly [string, string])[] = [
  ['W / S', 'Throttle and brake'],
  ['A / D', 'Steer'],
  ['Space', 'Handbrake'],
  ['C', 'Change camera view'],
  ['R', 'Restart'],
  ['M', 'Mute'],
  ['Esc / P', 'Pause and resume'],
]

function button(label: string, className: string, parent: HTMLElement): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.textContent = label
  parent.appendChild(node)
  return node
}

export class PauseMenu {
  private readonly root: HTMLDivElement
  private readonly style: HTMLStyleElement
  private readonly resume: HTMLButtonElement
  private readonly qualityButtons = new Map<Quality, HTMLButtonElement>()
  private readonly focusable: HTMLButtonElement[] = []
  private opened = false

  constructor(options: PauseMenuOptions, container: HTMLElement = document.body) {
    this.style = document.createElement('style')
    this.style.textContent = CSS
    document.head.appendChild(this.style)

    this.root = document.createElement('div')
    this.root.className = 'pause-root'
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-modal', 'true')
    this.root.setAttribute('aria-label', 'Paused')
    this.root.setAttribute('aria-hidden', 'true')

    const card = document.createElement('div')
    card.className = 'pause-card'
    this.root.appendChild(card)

    const title = document.createElement('div')
    title.className = 'pause-title'
    title.textContent = 'PAUSED'
    card.appendChild(title)

    this.resume = button('RESUME', 'pause-btn pause-primary', card)
    this.resume.addEventListener('click', options.onResume)
    this.focusable.push(this.resume)

    // The quality picker is a radio group made of buttons.
    const qualitySection = document.createElement('div')
    const qualityLabel = document.createElement('div')
    qualityLabel.className = 'pause-label'
    qualityLabel.textContent = 'GRAPHICS QUALITY'
    const group = document.createElement('div')
    group.className = 'pause-quality'
    group.setAttribute('role', 'radiogroup')
    group.setAttribute('aria-label', 'Graphics quality')
    for (const quality of QUALITIES) {
      const choice = button(QUALITY_LABELS[quality], 'pause-btn', group)
      choice.setAttribute('role', 'radio')
      choice.addEventListener('click', () => {
        this.setQuality(quality)
        options.onQuality(quality)
      })
      this.qualityButtons.set(quality, choice)
      this.focusable.push(choice)
    }
    qualitySection.append(qualityLabel, group)
    card.appendChild(qualitySection)

    const restart = button('RESTART RACE', 'pause-btn', card)
    restart.addEventListener('click', options.onRestart)
    this.focusable.push(restart)

    const keys = document.createElement('dl')
    keys.className = 'pause-keys'
    for (const [key, action] of KEYS) {
      const dt = document.createElement('dt')
      dt.textContent = key
      const dd = document.createElement('dd')
      dd.textContent = action
      keys.append(dt, dd)
    }
    card.appendChild(keys)

    container.appendChild(this.root)
    this.setQuality(options.quality)
    window.addEventListener('keydown', this.onKeyDown)
  }

  get isOpen(): boolean {
    return this.opened
  }

  open(): void {
    if (this.opened) return
    this.opened = true
    this.root.classList.add('pause-open')
    this.root.setAttribute('aria-hidden', 'false')
    this.resume.focus() // so Space or Enter resumes, and the keyboard works without a mouse
  }

  close(): void {
    if (!this.opened) return
    this.opened = false
    this.root.classList.remove('pause-open')
    this.root.setAttribute('aria-hidden', 'true')
    // A focused button would make the input layer ignore the driving keys, so give the focus up.
    const active = document.activeElement
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur()
  }

  /** Shows which quality is selected. Does not call onQuality, so it is safe to use from a settings listener. */
  setQuality(quality: Quality): void {
    for (const [q, node] of this.qualityButtons) node.setAttribute('aria-checked', String(q === quality))
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    this.root.remove()
    this.style.remove()
  }

  // Keeps Tab inside the menu while it is open, so focus can't wander off to the browser's own controls.
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.opened || e.key !== 'Tab') return
    const first = this.focusable[0]!
    const last = this.focusable[this.focusable.length - 1]!
    const active = document.activeElement
    if (!this.root.contains(active)) {
      e.preventDefault()
      first.focus()
    } else if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }
}