import type { TrackData } from '@/entities/TrackData'

const PADDING = 14 // pixels between the track and the edge of the map

export class Minimap {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly base: HTMLCanvasElement // the road, drawn once
  private readonly dpr: number
  private readonly scale: number
  private readonly offsetX: number
  private readonly offsetY: number
  private lastKey = ''

  constructor(container: HTMLElement, track: TrackData, size = 180) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)

    this.canvas = document.createElement('canvas')
    this.canvas.width = Math.round(size * this.dpr)
    this.canvas.height = Math.round(size * this.dpr)
    Object.assign(this.canvas.style, {
      position: 'absolute',
      left: '12px',
      bottom: '12px',
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: '10px',
      background: 'rgba(10, 12, 18, 0.55)',
    })
    container.appendChild(this.canvas)

    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas is not available')
    this.ctx = ctx

    // Fit the whole circuit into the square, keeping its proportions and centring it.
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const s of track.samples) {
      minX = Math.min(minX, s.position.x)
      maxX = Math.max(maxX, s.position.x)
      minZ = Math.min(minZ, s.position.z)
      maxZ = Math.max(maxZ, s.position.z)
    }
    const width = maxX - minX
    const height = maxZ - minZ
    const room = size - PADDING * 2
    this.scale = room / Math.max(width, height, 1)
    this.offsetX = PADDING + (room - width * this.scale) / 2 - minX * this.scale
    this.offsetY = PADDING + (room - height * this.scale) / 2 - minZ * this.scale

    this.base = document.createElement('canvas')
    this.base.width = this.canvas.width
    this.base.height = this.canvas.height
    this.drawBase(track)
  }

  /** Call once per display frame with the car's position and heading. */
  update(x: number, z: number, heading: number): void {
    const px = x * this.scale + this.offsetX
    const py = z * this.scale + this.offsetY

    // Skip the redraw when nothing would visibly change.
    const key = `${Math.round(px * 2)},${Math.round(py * 2)},${Math.round(heading * 20)}`
    if (key === this.lastKey) return
    this.lastKey = key

    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.drawImage(this.base, 0, 0)

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.save()
    ctx.translate(px, py)
    ctx.rotate(-heading) // map x = world x and map y = world z, so a left turn is a negative rotation
    ctx.beginPath()
    ctx.moveTo(0, -7)
    ctx.lineTo(4.5, 5)
    ctx.lineTo(0, 2.5)
    ctx.lineTo(-4.5, 5)
    ctx.closePath()
    ctx.fillStyle = '#ff453a'
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
    ctx.restore()
  }

  dispose(): void {
    this.canvas.remove()
  }

  private drawBase(track: TrackData): void {
    const ctx = this.base.getContext('2d')
    if (!ctx) throw new Error('2D canvas is not available')
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)

    const path = new Path2D()
    track.samples.forEach((s, i) => {
      const px = s.position.x * this.scale + this.offsetX
      const py = s.position.z * this.scale + this.offsetY
      if (i === 0) path.moveTo(px, py)
      else path.lineTo(px, py)
    })
    path.closePath()

    // At this scale the real road width would be only a few pixels, so the line has a minimum.
    const roadWidth = Math.max(track.width * this.scale, 5)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)' // outline
    ctx.lineWidth = roadWidth + 3
    ctx.stroke(path)
    ctx.strokeStyle = '#3a3a3f' // road
    ctx.lineWidth = roadWidth
    ctx.stroke(path)

    // Start line: a short white bar across the road at sample 0.
    const start = track.sampleAt(0)
    const sx = start.position.x * this.scale + this.offsetX
    const sy = start.position.z * this.scale + this.offsetY
    const half = roadWidth / 2 + 2
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.lineCap = 'butt'
    ctx.beginPath()
    ctx.moveTo(sx - start.right.x * half, sy - start.right.z * half)
    ctx.lineTo(sx + start.right.x * half, sy + start.right.z * half)
    ctx.stroke()
  }
}