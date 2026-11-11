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

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
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
    for (const u of this.updatables) u.update(dt)
  }

  private render(alpha: number, frameDt: number): void {
    // Hooks run before drawing so they can interpolate positions and move the camera.
    for (const hook of this.renderHooks) hook(alpha, frameDt)
    this.renderer.render(this.scene, this.camera)
    this.debug.update(frameDt, this.renderer.info)
  }

  private onResize = (): void => {
    const w = window.innerWidth
    const h = window.innerHeight
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }
}