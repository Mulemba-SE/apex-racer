import * as THREE from 'three'
import { GameLoop } from '@/core/GameLoop'
import { DebugOverlay } from '@/ui/DebugOverlay'

export interface Updatable {
  update(dt: number): void
}

export type RenderHook = (alpha: number, frameDt: number) => void

export class Game {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000)

  private readonly loop: GameLoop
  private readonly debug = new DebugOverlay()
  private readonly updatables = new Set<Updatable>()
  private readonly renderHooks = new Set<RenderHook>()

  private paused = false
  private settling = false // after resuming: show the paused picture until the first real step has run
  private maxPixelRatio = 2

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    container.appendChild(this.renderer.domElement)

    this.camera.position.set(0, 3, 8)
    this.scene.background = new THREE.Color(0x87b8e8)

    window.addEventListener('resize', this.onResize)
    this.onResize()

    this.loop = new GameLoop({
      update: (dt) => this.update(dt),
      render: (alpha, frameDt) => this.render(alpha, frameDt),
    })
  }

  get isPaused(): boolean {
    return this.paused
  }

  /**
   * Freezes or unfreezes the simulation. While paused the fixed steps don't run, but the render
   * hooks still do, with a frame time of zero, so nothing that moves with time (the smoke, the
   * camera blend) advances, and the screen keeps drawing.
   */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return
    this.paused = paused
    this.settling = !paused
  }

  /** The most device pixels per CSS pixel the renderer draws. Lower is faster and less sharp. */
  setMaxPixelRatio(ratio: number): void {
    this.maxPixelRatio = Math.max(0.5, ratio)
    this.onResize()
  }

  /**
   * Changes the resolution of a light's shadow map. Three.js reads the size only when it creates
   * the map, so the old map is freed and the next render makes a new one at the new size.
   */
  setShadowMapSize(light: THREE.DirectionalLight, size: number): void {
    if (light.shadow.mapSize.x === size && light.shadow.mapSize.y === size) return
    light.shadow.mapSize.set(size, size)
    light.shadow.map?.dispose()
    light.shadow.map = null
  }

  add(u: Updatable): void {
    this.updatables.add(u)
  }

  remove(u: Updatable): void {
    this.updatables.delete(u)
  }

  addRenderHook(hook: RenderHook): void {
    this.renderHooks.add(hook)
  }

  removeRenderHook(hook: RenderHook): void {
    this.renderHooks.delete(hook)
  }

  start(): void {
    this.loop.start()
  }

  dispose(): void {
    this.loop.stop()
    window.removeEventListener('resize', this.onResize)
    this.debug.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private update(dt: number): void {
    if (this.paused) return // the loop keeps ticking; the simulation just doesn't move
    this.settling = false // a real step has run, so the next picture continues smoothly from the paused one
    for (const u of this.updatables) u.update(dt)
  }

  private render(alpha: number, frameDt: number): void {
    // While paused (and for the first frame after resuming, until a step has run) everything is
    // drawn at its latest simulated state. Otherwise the loop's alpha would swing between the last
    // two steps, and the cars would shuffle back and forth on screen.
    const frozen = this.paused || this.settling
    const hookAlpha = frozen ? 1 : alpha
    const hookDt = this.paused ? 0 : frameDt

    // Hooks run before drawing so they can interpolate positions and move the camera.
    for (const hook of this.renderHooks) hook(hookAlpha, hookDt)
    this.renderer.render(this.scene, this.camera)
    this.debug.update(frameDt, this.renderer.info) // the real frame time, so the FPS counter stays honest
  }

  private onResize = (): void => {
    const w = window.innerWidth
    const h = window.innerHeight
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.maxPixelRatio))
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }
}