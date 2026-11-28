const CSS = `
.prompt {
  position: absolute;
  left: 50%;
  bottom: 20%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px 8px 10px;
  border-radius: 12px;
  background: rgba(10, 12, 18, 0.62);
  backdrop-filter: blur(4px);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  font: 600 16px system-ui;
  letter-spacing: 0.06em;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.prompt.prompt-visible { opacity: 1; }
.prompt-key {
  min-width: 28px;
  padding: 3px 8px;
  border-radius: 6px;
  background: #ffd60a;
  color: #14161c;
  font: 800 15px ui-monospace, monospace;
  text-align: center;
  text-shadow: none;
}
.prompt-key.prompt-nokey { display: none; }
.prompt.prompt-flash { padding-left: 16px; }
@media (prefers-reduced-motion: reduce) {
  .prompt { transition: none; }
}
`

interface Message {
  key: string // the key cap's text, or '' for none
  text: string
  visible: boolean
}

export class Prompt {
  private readonly root: HTMLDivElement
  private readonly keyEl: HTMLSpanElement
  private readonly textEl: HTMLSpanElement
  private readonly style: HTMLStyleElement

  private readonly base: Message = { key: '', text: '', visible: false } // what show() and hide() asked for
  private flashText: string | null = null // a short message that takes over for a moment
  private flashTimer: number | null = null

  constructor(container: HTMLElement) {
    this.style = document.createElement('style')
    this.style.textContent = CSS
    document.head.appendChild(this.style)

    this.root = document.createElement('div')
    this.root.className = 'prompt'
    this.root.setAttribute('role', 'status')
    this.root.setAttribute('aria-live', 'polite')

    this.keyEl = document.createElement('span')
    this.keyEl.className = 'prompt-key'
    this.textEl = document.createElement('span')
    this.root.append(this.keyEl, this.textEl)
    container.appendChild(this.root)
  }

  /**
   * Shows "[key] text". Safe to call every frame: nothing is touched unless the key, the text or the
   * visibility changed. While a flash message is showing, this is remembered and takes over afterwards.
   */
  show(key: string, text: string): void {
    if (this.base.visible && this.base.key === key && this.base.text === text) return
    this.base.key = key
    this.base.text = text
    this.base.visible = true
    this.render()
  }

  hide(): void {
    if (!this.base.visible) return
    this.base.visible = false
    this.render()
  }

  /** Shows a short message with no key cap for `ms` milliseconds, then returns to whatever was showing. */
  flash(text: string, ms = 1800): void {
    this.flashText = text
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer)
    this.flashTimer = window.setTimeout(() => {
      this.flashTimer = null
      this.flashText = null
      this.render()
    }, ms)
    this.render()
  }

  dispose(): void {
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer)
    this.root.remove()
    this.style.remove()
  }

  private render(): void {
    const flashing = this.flashText !== null
    const key = flashing ? '' : this.base.key
    const text = flashing ? this.flashText! : this.base.text
    const visible = flashing || this.base.visible

    if (this.textEl.textContent !== text && (visible || text !== '')) this.textEl.textContent = text
    if (this.keyEl.textContent !== key) this.keyEl.textContent = key
    this.keyEl.classList.toggle('prompt-nokey', key === '')
    this.root.classList.toggle('prompt-flash', flashing)
    this.root.classList.toggle('prompt-visible', visible)
  }
}