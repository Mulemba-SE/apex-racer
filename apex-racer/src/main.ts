import * as THREE from 'three'
import { BestTimes } from '@/core/BestTimes'
import { Game } from '@/core/Game'
import { Input } from '@/core/Input'
import { RaceController } from '@/core/RaceController'
import { Car } from '@/entities/Car'
import { Track } from '@/entities/Track'
import { TrackData, CIRCUIT_ONE } from '@/entities/TrackData'
import { CameraRig } from '@/systems/CameraRig'
import { LapTracker } from '@/systems/LapTracker'
import { TrackCollision } from '@/systems/TrackCollision'

const TOTAL_LAPS = 3 // set to 1 while testing if you want a quick finish

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

// Input, car, camera.
const input = new Input()
const car = new Car(input.controls)
const grid = track.data.poseAt(-10) // 10 m behind the start line
car.reset(grid.x, grid.z, grid.heading)
game.scene.add(car.object)
const rig = new CameraRig(game.camera, car) // after the reset, so it starts behind the car

// Race systems. The tracker is created after the car is on the grid, because
// it reads the car's position when it is built.
const collision = new TrackCollision(car, track.data)
const tracker = new LapTracker(car, track.data, TOTAL_LAPS)
const race = new RaceController({
  input,
  car,
  tracker,
  bestTimes: new BestTimes(track.data.definition.name),
  respawn: () => {
    car.reset(grid.x, grid.z, grid.heading)
    rig.snap()
  },
})

// Fixed-step order matters:
// the input is sampled, the race controller applies locks and brakes, the car
// moves, the collision corrects it, and the tracker reads the final position.
game.add(input)
game.add(race)
game.add(car)
game.add(collision)
game.add(tracker)

// ---------------------------------------------------------------------------
// Temporary text readout. Segment 8 replaces this with a proper HUD.
// ---------------------------------------------------------------------------

const hud = document.getElementById('hud')!

const readout = document.createElement('pre')
Object.assign(readout.style, {
  position: 'absolute',
  top: '8px',
  right: '12px',
  margin: '0',
  padding: '8px 10px',
  font: '600 16px/1.5 ui-monospace, monospace',
  color: '#fff',
  background: 'rgba(0, 0, 0, 0.45)',
  textShadow: '0 1px 2px #000',
  whiteSpace: 'pre',
})
hud.appendChild(readout)

const banner = document.createElement('div')
Object.assign(banner.style, {
  position: 'absolute',
  top: '24%',
  left: '0',
  width: '100%',
  textAlign: 'center',
  color: '#fff',
  textShadow: '0 2px 8px #000',
  whiteSpace: 'pre',
})
const bannerTitle = document.createElement('div')
bannerTitle.style.font = '800 80px/1.1 system-ui'
const bannerSub = document.createElement('div')
bannerSub.style.font = '600 20px/1.5 system-ui'
banner.append(bannerTitle, bannerSub)
hud.appendChild(banner)

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text // avoids touching the page when nothing changed
}

function formatTime(seconds: number | null): string {
  if (seconds === null) return '-:--.---'
  const ms = Math.round(Math.max(0, seconds) * 1000)
  const m = Math.floor(ms / 60000)
  const s = (ms % 60000) / 1000
  return `${m}:${s.toFixed(3).padStart(6, '0')}`
}

function updateHud(): void {
  const lapShown = race.state === 'menu' ? '-' : String(tracker.currentLap)
  setText(
    readout,
    [
      `LAP    ${lapShown}/${tracker.totalLaps}`,
      `TIME   ${formatTime(tracker.currentLapTime)}`,
      `LAST   ${formatTime(tracker.lastLap)}`,
      `BEST   ${formatTime(tracker.bestLap)}`,
      `SPEED  ${Math.round(car.speedKmh)} km/h`,
    ].join('\n'),
  )

  let title = ''
  let sub = ''
  switch (race.state) {
    case 'menu':
      title = 'APEX RACER'
      sub = 'Press ENTER to start\nW/S throttle and brake   A/D steer   SPACE handbrake   R restart'
      break
    case 'countdown':
    case 'racing':
      title = race.countdownText
      break
    case 'finished':
      title = 'FINISH'
      sub =
        `Race ${formatTime(tracker.raceTime)}  |  Best lap ${formatTime(tracker.bestLap)}\n` +
        'Press ENTER to race again'
      break
  }
  setText(bannerTitle, title)
  setText(bannerSub, sub)
}

// Once per display frame: place the car between its last two physics steps,
// move the camera to follow it, keep the sun's shadow box over the car,
// then refresh the readout.
game.addRenderHook((alpha, frameDt) => {
  car.interpolate(alpha)
  rig.update(frameDt)
  sun.position.copy(car.object.position).add(SUN_OFFSET)
  sun.target.position.copy(car.object.position)
  updateHud()
})

game.start()

// Avoid duplicate games and listeners when Vite hot-reloads this file.
import.meta.hot?.dispose(() => {
  input.dispose()
  track.dispose()
  game.dispose()
  readout.remove()
  banner.remove()
})