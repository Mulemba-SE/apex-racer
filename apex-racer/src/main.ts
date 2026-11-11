import * as THREE from 'three'
import { Game, type Updatable } from '@/core/Game'

const game = new Game(document.getElementById('app')!)

// Lighting
game.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.0))
const sun = new THREE.DirectionalLight(0xffffff, 2)
sun.position.set(5, 10, 4)
sun.castShadow = true
game.scene.add(sun)

// Ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(100, 100),
  new THREE.MeshStandardMaterial({ color: 0x3a6b35 })
)
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
game.scene.add(ground)

// Test object, driven by the fixed-step update
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0xff4422 })
)
cube.position.y = 1
cube.castShadow = true
game.scene.add(cube)

const spinner: Updatable = {
  update(dt) {
    cube.rotation.y += dt // exactly 1 radian per second at any frame rate
  },
}
game.add(spinner)

game.start()

// Avoid duplicate games when Vite hot-reloads this file
import.meta.hot?.dispose(() => game.dispose())