import { CAMERA_LABELS, type CameraMode } from '@/systems/CameraRig'

const CSS = `
.view-label {
  position: absolute;
  left: 50%;
  top: 12px;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: 10px;
  background: rgba(10, 12, 18, 0.55);
  backdrop-filter: blur(4px);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  font: 600 13px system-ui;
  letter-spacing: 0.12em;
  white-space: nowrap;
}
.view-label-key {
  margin-right: 8px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.2);
  font: 700 12px ui-monospace, monospace;
}
`

/** A small label at the top of the screen that names the current camera view. */
export class ViewLabel {
  private readonly root: HTMLDivElement
  private readonly name: HTMLSpanElement
  private readonly style: HTMLStyleElement

  constructor(container: HTMLElement) {
    this.style = document.createElement('style')
    this.style.textContent = CSS
    document.head.appendChild(this.style)

    this.root = document.createElement('div')
    this.root.className = 'view-label'

    const key = document.createElement('span')
    key.className = 'view-label-key'
    key.textContent = 'C'

    this.name = document.createElement('span')
    this.root.append(key, this.name)
    container.appendChild(this.root)
  }

  /** Shows the name of a view. A short pop draws the eye when it changes. */
  set(mode: CameraMode): void {
    const text = `VIEW  ${CAMERA_LABELS[mode]}`
    if (this.name.textContent === text) return
    const first = this.name.textContent === ''
    this.name.textContent = text
    if (first) return
    this.root.animate(
      [
        { transform: 'translateX(-50%) scale(1.15)' },
        { transform: 'translateX(-50%) scale(1)' },
      ],
      { duration: 180, easing: 'ease-out' },
    )
  }

  dispose(): void {
    this.root.remove()
    this.style.remove()
  }
}