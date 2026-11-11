import * as THREE from 'three'
import { Game } from '@/core/Game'
import { Input } from '@/core/Input'
import { Car } from '@/entities/Car'
import { CameraRig } from '@/systems/CameraRig'

const game = new Game(document.getElementById('app')!)

// Sky and fog. The fog hides the edge of the test ground.
const SKY = 0x87b8e8
game.scene.background = new THREE.Color(SKY)
game.scene.fog = new THREE.Fog(SKY, 150, 900)

// Lighting. The sun follows the car (see the render hook below), so the
// shadow map only has to cover the area around the car.
game.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.0))
const sun = new THREE.DirectionalLight(0xffffff, 2.2)
const SUN_OFFSET = new THREE.Vector3(30, 50, 20)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.camera.left = -40
sun.shadow.camera.right = 40
sun.shadow.camera.top = 40
sun.shadow.camera.bottom = -40
sun.shadow.camera.far = 150
game.scene.add(sun, sun.target)

// Test ground: large, with a grid so you can see how fast you are moving.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(3000, 3000),
  new THREE.MeshStandardMaterial({ color: 0x3a6b35 }),
)
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
game.scene.add(ground)

const grid = new THREE.GridHelper(3000, 600, 0x2b5227, 0x2f5a2b) // 5 m cells
grid.position.y = 0.02 // just above the ground to avoid z-fighting
game.scene.add(grid)

// Reference pillars every 40 m on a grid, for judging speed and turning.
const pillarGeo = new THREE.BoxGeometry(1.5, 6, 1.5)
const pillarMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e })
for (let x = -200; x <= 200; x += 40) {
  for (let z = -200; z <= 200; z += 40) {
    if (x === 0 && z === 0) continue // keep the start position clear
    const pillar = new THREE.Mesh(pillarGeo, pillarMat)
    pillar.position.set(x, 3, z)
    pillar.castShadow = true
    pillar.receiveShadow = true
    game.scene.add(pillar)
  }
}

// Input, car, camera. Input is added first, so each fixed step reads the
// keys before the car uses them.
const input = new Input()
const car = new Car(input.controls)
game.scene.add(car.object)
const rig = new CameraRig(game.camera, car)

game.add(input)
game.add(car)
game.add({
  // Reset is checked in the fixed step, right after the car has updated.
  update() {
    if (input.consumeReset()) {
      car.reset(0, 0, 0)
      rig.snap()
    }
  },
})

// Once per display frame: place the car between its last two physics steps,
// move the camera to follow it, then keep the sun's shadow box over the car.
game.addRenderHook((alpha, frameDt) => {
  car.interpolate(alpha)
  rig.update(frameDt)
  sun.position.copy(car.object.position).add(SUN_OFFSET)
  sun.target.position.copy(car.object.position)
})

game.start()

// Avoid duplicate games and listeners when Vite hot-reloads this file.
import.meta.hot?.dispose(() => {
  input.dispose()
  game.dispose()
})