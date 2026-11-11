import * as THREE from 'three'
import { Game } from '@/core/Game'
import { Input } from '@/core/Input'
import { Car } from '@/entities/Car'
import { Track } from '@/entities/Track'
import { TrackData, CIRCUIT_ONE } from '@/entities/TrackData'
import { CameraRig } from '@/systems/CameraRig'

const game = new Game(document.getElementById('app')!)

// A larger near plane gives the depth buffer more precision, which stops the
// road and kerbs flickering against the ground at a distance.
game.camera.near = 0.3
game.camera.updateProjectionMatrix()

// Sky and fog. The fog hides the edge of the ground.
const SKY = 0x87b8e8
game.scene.background = new THREE.Color(SKY)
game.scene.fog = new THREE.Fog(SKY, 200, 1000)

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
sun.shadow.bias = -0.0005 // together these stop shadow striping on the road
sun.shadow.normalBias = 0.05
game.scene.add(sun, sun.target)

// Grass, sunk below the road so the two never fight in the depth buffer.
const grass = new THREE.Mesh(
  new THREE.PlaneGeometry(3000, 3000),
  new THREE.MeshStandardMaterial({ color: 0x3a6b35, roughness: 1 }),
)
grass.rotation.x = -Math.PI / 2
grass.position.y = -0.1
grass.receiveShadow = true
game.scene.add(grass)

// Track
const track = new Track(new TrackData(CIRCUIT_ONE))
game.scene.add(track.object)

// Input, car, camera. Input is added first, so each fixed step reads the
// keys before the car uses them.
const input = new Input()
const car = new Car(input.controls)
const grid = track.data.poseAt(-10) // 10 m behind the start line
car.reset(grid.x, grid.z, grid.heading)
game.scene.add(car.object)
const rig = new CameraRig(game.camera, car) // after the reset, so it starts behind the car

game.add(input)
game.add(car)
game.add({
  // Reset is checked in the fixed step, right after the car has updated.
  update() {
    if (input.consumeReset()) {
      car.reset(grid.x, grid.z, grid.heading)
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
  track.dispose()
  game.dispose()
})