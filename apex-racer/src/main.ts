import * as THREE from 'three'
import { AudioEngine } from '@/core/AudioEngine'
import { BestTimes } from '@/core/BestTimes'
import { Game } from '@/core/Game'
import { Input, type Controls } from '@/core/Input'
import { RaceController } from '@/core/RaceController'
import { Car } from '@/entities/Car'
import { Track } from '@/entities/Track'
import { TrackData, CIRCUIT_ONE, type Pose } from '@/entities/TrackData'
import { AIDriver, type AIOptions } from '@/systems/AIDriver'
import { CameraRig } from '@/systems/CameraRig'
import { CarCollision } from '@/systems/CarCollision'
import { LapTracker } from '@/systems/LapTracker'
import { Standings } from '@/systems/Standings'
import { TrackCollision } from '@/systems/TrackCollision'
import { Hud } from '@/ui/Hud'
import { Minimap, type MinimapDot } from '@/ui/Minimap'

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

// Lighting. The sun follows the player's car (see the render hook below), so the
// shadow map only has to cover the area around it.
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

// ---------------------------------------------------------------------------
// Starting grid: slot 0 is pole position. `back` is metres behind the start
// line, and `side` is the offset from the centre line (positive is right).
// ---------------------------------------------------------------------------

const GRID = [
  { back: 8, side: -2.5 },
  { back: 8, side: 2.5 },
  { back: 16, side: -2.5 },
  { back: 16, side: 2.5 },
] as const

const PLAYER_SLOT = 3 // change to 0 to start on pole

function gridPose(slot: number): Pose {
  const { back, side } = GRID[slot]!
  const s = track.data.sampleAt(Math.round(-back / track.data.spacing))
  return {
    x: s.position.x + s.right.x * side,
    z: s.position.z + s.right.z * side,
    heading: Math.atan2(-s.tangent.x, -s.tangent.z), // same conversion as TrackData.poseAt()
  }
}

// Player: input, car, camera.
const input = new Input()
const car = new Car(input.controls)
const playerGrid = gridPose(PLAYER_SLOT)
car.reset(playerGrid.x, playerGrid.z, playerGrid.heading)
game.scene.add(car.object)
const rig = new CameraRig(game.camera, car) // after the reset, so it starts behind the car

// AI opponents. Each one has its own Controls object, written by its driver.
// Drivers differ in pace and in the line they take. Keep laneOffset within
// about +-4 m so they stay on the asphalt.
interface BotSetup {
  slot: number
  color: number
  options: Partial<AIOptions>
}

const BOT_SETUPS: BotSetup[] = [
  { slot: 0, color: 0x2a6fdb, options: { topSpeedFraction: 0.95, cornerAccel: 24, laneOffset: -2.5 } },
  { slot: 1, color: 0xf2c14e, options: { topSpeedFraction: 0.9, cornerAccel: 22, laneOffset: 2.5 } },
  { slot: 2, color: 0x2fb36a, options: { topSpeedFraction: 0.85, cornerAccel: 20, laneOffset: -1 } },
]

const bots = BOT_SETUPS.map(({ slot, color, options }) => {
  const controls: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false }
  const botCar = new Car(controls, {}, color)
  const pose = gridPose(slot)
  botCar.reset(pose.x, pose.z, pose.heading)
  game.scene.add(botCar.object)
  return {
    car: botCar,
    color,
    driver: new AIDriver(botCar, controls, track.data, options),
    collision: new TrackCollision(botCar, track.data),
    grid: pose,
  }
})

// Race systems. The tracker and standings are created after every car is on
// the grid, because both read the cars' positions when they are built.
const collision = new TrackCollision(car, track.data)
const carCollision = new CarCollision([car, ...bots.map((b) => b.car)])
const tracker = new LapTracker(car, track.data, TOTAL_LAPS)
const standings = new Standings([car, ...bots.map((b) => b.car)], track.data, TOTAL_LAPS)
const race = new RaceController({
  input,
  car,
  tracker,
  bestTimes: new BestTimes(track.data.definition.name),
  respawn: () => {
    car.reset(playerGrid.x, playerGrid.z, playerGrid.heading)
    rig.snap()
    for (const bot of bots) {
      bot.car.reset(bot.grid.x, bot.grid.z, bot.grid.heading)
      bot.driver.reset()
    }
    standings.reset() // after every car is back on the grid
  },
})

// The AI drives, and positions are tracked, from GO onwards. Both carry on
// after you finish, so the AI cars can still earn their places.
race.onStateChange = (state) => {
  const running = state === 'racing' || state === 'finished'
  for (const bot of bots) bot.driver.enabled = running
  standings.active = running
}

// Fixed-step order matters:
// the input is sampled, the race controller applies locks and brakes, the AI
// drivers press their pedals, every car moves, cars push each other apart, each
// wall collision then corrects its own car (so the walls have the last word),
// and the tracker and standings read the final positions.
game.add(input)
game.add(race)
for (const bot of bots) game.add(bot.driver)
game.add(car)
for (const bot of bots) game.add(bot.car)
game.add(carCollision)
game.add(collision)
for (const bot of bots) game.add(bot.collision)
game.add(tracker)
game.add(standings)

// UI and audio.
const hudContainer = document.getElementById('hud')!
const hud = new Hud(hudContainer)
const minimap = new Minimap(hudContainer, track.data)
const audio = new AudioEngine()

// One reusable dot per AI car, so the render hook creates no garbage.
const dots: MinimapDot[] = bots.map((b) => ({ x: 0, z: 0, color: b.color }))

race.onCountdownTick = (value) => audio.countdownTick(value)
race.onLap = (result) => {
  hud.showLapToast(result.lap, result.time, result.isBest)
  audio.lapChime(result.isBest)
}
race.onFinish = () => audio.finish()
collision.onImpact = (speed) => audio.impact(speed) // the player's wall crashes
carCollision.onImpact = (speed, a, b) => {
  if (a === car || b === car) audio.impact(speed) // only crashes involving the player are audible
}

// Once per display frame: place every car between its last two physics steps,
// move the camera to follow the player, keep the sun's shadow box over the
// player, then refresh the HUD, minimap and audio.
game.addRenderHook((alpha, frameDt) => {
  car.interpolate(alpha)
  for (const bot of bots) bot.car.interpolate(alpha)
  rig.update(frameDt)
  sun.position.copy(car.object.position).add(SUN_OFFSET)
  sun.target.position.copy(car.object.position)

  const speedFraction = car.velocity.length() / car.config.maxSpeed

  hud.update({
    state: race.state,
    countdownText: race.countdownText,
    lap: tracker.currentLap,
    totalLaps: tracker.totalLaps,
    lapTime: tracker.currentLapTime,
    lastLap: tracker.lastLap,
    bestLap: tracker.bestLap,
    raceTime: tracker.raceTime,
    speedKmh: car.speedKmh,
    speedFraction,
    position: standings.positionOf(car),
    racers: standings.count,
  })

  bots.forEach((bot, i) => {
    const dot = dots[i]!
    dot.x = bot.car.object.position.x
    dot.z = bot.car.object.position.z
  })
  minimap.update(car.object.position.x, car.object.position.z, car.object.rotation.y, dots)

  // Sideways speed in m/s: the part of the velocity along the car's right-hand axis.
  const sin = Math.sin(car.heading)
  const cos = Math.cos(car.heading)
  const slip = car.velocity.x * cos - car.velocity.z * sin

  audio.update({
    engineOn: race.state !== 'menu',
    speedFraction,
    throttle: input.controls.throttle,
    slip,
  })
})

game.start()

// Avoid duplicate games and listeners when Vite hot-reloads this file.
import.meta.hot?.dispose(() => {
  input.dispose()
  audio.dispose()
  minimap.dispose()
  hud.dispose()
  track.dispose()
  game.dispose()
})