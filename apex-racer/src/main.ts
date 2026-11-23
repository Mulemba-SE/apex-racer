import * as THREE from 'three'
import { AudioEngine } from '@/core/AudioEngine'
import { BestTimes } from '@/core/BestTimes'
import { Game } from '@/core/Game'
import { Input, type Controls } from '@/core/Input'
import { RaceController } from '@/core/RaceController'
import { Settings } from '@/core/Settings'
import { Buildings } from '@/entities/Buildings'
import { Car } from '@/entities/Car'
import { CarModelLoader, type CarModelOptions } from '@/entities/CarModel'
import { createFacadeStyles, disposeFacadeStyles } from '@/entities/FacadeTextures'
import { Props } from '@/entities/Props'
import { Track } from '@/entities/Track'
import { TrackData, CIRCUIT_ONE, type Pose } from '@/entities/TrackData'
import { AIDriver, type AIOptions } from '@/systems/AIDriver'
import { CameraRig } from '@/systems/CameraRig'
import { CarCollision } from '@/systems/CarCollision'
import { LapTracker } from '@/systems/LapTracker'
import { SkidMarks } from '@/systems/SkidMarks'
import { Smoke } from '@/systems/Smoke'
import { Standings } from '@/systems/Standings'
import { TrackCollision } from '@/systems/TrackCollision'
import { TrackSpace } from '@/systems/TrackSpace'
import { Hud } from '@/ui/Hud'
import { LoadingScreen } from '@/ui/LoadingScreen'
import { Minimap, type MinimapDot } from '@/ui/Minimap'
import { PauseMenu } from '@/ui/PauseMenu'
import { ViewLabel } from '@/ui/ViewLabel'

const TOTAL_LAPS = 3 // set to 1 while testing if you want a quick finish

// The car models, served from public/models. BASE_URL keeps the paths correct when the game
// is hosted in a sub-folder (GitHub Pages, for example).
// The player's car uses the full model. The AI cars use a simplified copy (car-lite.glb), because
// they are seen from a distance and cost far less to draw. If the lite file is missing, they fall
// back to the full model.
const MODEL_URL = `${import.meta.env.BASE_URL}models/car.glb`
const MODEL_LITE_URL = `${import.meta.env.BASE_URL}models/car-lite.glb`
const MODEL_TIMEOUT_MS = 30000
const MODEL_OPTIONS: Omit<CarModelOptions, 'url' | 'paintColor'> = {
  yaw: Math.PI, // 0 if the car drives backwards, +-Math.PI / 2 if it points sideways
  // paintPattern: /body|paint/i, // which material names count as paint; see the console message
}
const PLAYER_COLOR = 0xd62828

// Parts of the model that only matter from inside the car. The AI cars are only seen from outside,
// so these are not drawn on them, which saves draw calls and triangles. The names come from the
// model's material list in the console.
const AI_HIDDEN_MATERIALS =
  /^(interior|carbon_int|alca_int|steer_plastic|steer_alca|steer_metal|carbon_steer|hud|CSR2_InteriorA)$/i

// Shown immediately, and removed once the car models have loaded (or failed to).
const loading = new LoadingScreen()

// The saved graphics quality and control scheme. Both are applied below, once what they affect exists.
const settings = new Settings()

const game = new Game(document.getElementById('app')!)

// The near plane is set by CameraRig for each view: large for the chase views, where it stops
// the road and kerbs flickering at a distance, and small for the first-person views.

// Sky and fog. The fog hides the edge of the ground.
const SKY = 0x87b8e8
game.scene.background = new THREE.Color(SKY)
game.scene.fog = new THREE.Fog(SKY, 200, 1000)

// Lighting. The sun follows the player's car (see the render hook below), so the
// shadow map only has to cover the area around it. Whether it casts shadows, and the resolution of
// its shadow map, come from the quality setting.
game.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.0))
const sun = new THREE.DirectionalLight(0xffffff, 2.2)
const SUN_OFFSET = new THREE.Vector3(30, 50, 20)
sun.castShadow = true
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

// Scenery: buildings, trees, street lamps and a grandstand. It is planned once, using one shared
// TrackSpace so nothing stands on any part of the road. The quality presets decide how much of it
// is shown, and none of it casts or receives shadows.
const scenery = settings.preset
const facades = createFacadeStyles(Math.min(4, game.renderer.capabilities.getMaxAnisotropy()))
const space = new TrackSpace(track.data)
const buildings = new Buildings(space, facades, { density: scenery.buildingDensity })
game.scene.add(buildings.object)
const props = new Props(space, buildings.footprints, { treeDensity: scenery.treeDensity })
game.scene.add(props.object)
let sceneryQuality = settings.quality // the quality the scenery was last built for

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
input.setScheme(settings.controlScheme) // keyboard, or keyboard plus mouse, as last chosen
const car = new Car(input.controls, {}, PLAYER_COLOR)
const playerGrid = gridPose(PLAYER_SLOT)
car.reset(playerGrid.x, playerGrid.z, playerGrid.heading)
game.scene.add(car.object)
const rig = new CameraRig(game.camera, car) // after the reset, so it starts behind the car

// Temporary, for tuning. In development only, it exposes objects to the browser console, e.g.
// car.viewAnchors.cockpit.position.set(0, 0.85, -0.2), input.mouse.fullLock = 0.45, or
// game.renderer.info.memory to check for leaks. Delete this line once you are done.
if (import.meta.env.DEV) Object.assign(window, { car, rig, game, settings, input, buildings, props, space })

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

// Tyre marks and smoke for every car.
const skidMarks = new SkidMarks([car, ...bots.map((b) => b.car)])
game.scene.add(skidMarks.object)
const smoke = new Smoke([car, ...bots.map((b) => b.car)])
game.scene.add(smoke.object)

// Graphics quality: how sharp the picture is, whether and how the sun casts shadows, how thick the
// smoke is, and how much scenery is shown. Called at start-up and whenever the quality changes.
function applyQuality(): void {
  const preset = settings.preset
  game.setMaxPixelRatio(preset.pixelRatio)

  // Turning the sun's shadows on or off makes the renderer rebuild its shaders once, so the picture
  // may hitch for a moment when this changes. Nothing else needs doing: with no shadow-casting light,
  // surfaces skip the shadow lookup as well.
  sun.castShadow = preset.shadows
  game.setShadowMapSize(sun, preset.shadowMapSize)
  for (const c of [car, ...bots.map((b) => b.car)]) c.setDetailedShadows(preset.detailedShadows)

  smoke.density = preset.smokeDensity

  // The scenery is only rebuilt when the quality actually changed, not for every setting change.
  if (settings.quality !== sceneryQuality) {
    sceneryQuality = settings.quality
    buildings.setDensity(preset.buildingDensity)
    props.setTreeDensity(preset.treeDensity)
  }
}
applyQuality()

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
    skidMarks.clear()
    smoke.clear()
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
const viewLabel = new ViewLabel(hudContainer)
viewLabel.set(rig.mode)
const audio = new AudioEngine()

// ---------------------------------------------------------------------------
// Pause. The simulation stops, the screen keeps drawing, and the menu opens.
// ---------------------------------------------------------------------------

const pauseMenu = new PauseMenu({
  quality: settings.quality,
  controls: settings.controlScheme,
  onResume: () => setPaused(false),
  onRestart: () => {
    setPaused(false)
    race.restart()
  },
  onQuality: (quality) => settings.setQuality(quality),
  onControls: (scheme) => settings.setControlScheme(scheme),
})

function setPaused(paused: boolean): void {
  if (paused === game.isPaused) return
  game.setPaused(paused)
  if (paused) {
    pauseMenu.open()
  } else {
    pauseMenu.close()
    // R or Enter pressed during the pause was queued, and would fire the moment the race resumes.
    input.consumeReset()
    input.consumeConfirm()
  }
}

// Switching to another browser tab in the middle of a race pauses it.
const onVisibility = (): void => {
  const state = race.state
  if (document.hidden && (state === 'racing' || state === 'countdown')) setPaused(true)
}
document.addEventListener('visibilitychange', onVisibility)

// A settings change from anywhere applies at once and shows in the menu.
const stopSettings = settings.onChange(() => {
  applyQuality()
  input.setScheme(settings.controlScheme)
  pauseMenu.setQuality(settings.quality)
  pauseMenu.setControls(settings.controlScheme)
})

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

// Once per display frame: check the pause key, place every car between its last two physics steps,
// update the tyre marks, move the camera to follow the player, update the smoke
// (it reads the camera's field of view), keep the sun's shadow box over the
// player, then refresh the HUD, minimap and audio. This keeps running while paused.
game.addRenderHook((alpha, frameDt) => {
  if (input.consumePause()) setPaused(!game.isPaused)

  car.interpolate(alpha)
  for (const bot of bots) bot.car.interpolate(alpha)
  skidMarks.update() // after every car is interpolated: the marks follow the visual positions
  if (input.consumeCamera()) viewLabel.set(rig.cycle()) // before the update, so the blend starts this frame
  rig.update(frameDt)
  smoke.update(frameDt, game.camera, game.renderer.domElement.height)
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
    engineOn: race.state !== 'menu' && !game.isPaused, // the engine, tyres and wind fade out while paused
    speedFraction,
    throttle: input.controls.throttle,
    slip,
  })
})

// ---------------------------------------------------------------------------
// Car models. The game only starts once they have loaded, or failed to.
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${what} timed out after ${ms / 1000} s`)),
      ms,
    )
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function loadCarModels(): Promise<void> {
  const loader = new CarModelLoader()

  // The lite model downloads at the same time as the full one. A failure here is not fatal: the AI
  // cars simply use the full model instead. The error is handled here, so it can't go unreported.
  const liteReady = loader.load(MODEL_LITE_URL).then(
    () => true,
    (error) => {
      console.warn('Lite car model unavailable, the AI cars will use the full model:', error)
      return false
    },
  )

  await loader.load(MODEL_URL, (fraction) => loading.setProgress(fraction)) // the progress bar follows the big file
  loading.setStatus('PREPARING')
  const aiUrl = (await liteReady) ? MODEL_LITE_URL : MODEL_URL

  const all = [
    { car, color: PLAYER_COLOR, player: true },
    ...bots.map((b) => ({ car: b.car, color: b.color, player: false })),
  ]
  for (const entry of all) {
    // Each car gets its own copy, repainted in its own colour. The geometry is shared.
    const url = entry.player ? MODEL_URL : aiUrl
    const model = await loader.create({ url, ...MODEL_OPTIONS, paintColor: entry.color })
    entry.car.setModel(model)
    // The AI cars are only seen from outside, so their cockpit is not drawn. Your own car keeps it.
    if (!entry.player) entry.car.setHiddenMaterials(AI_HIDDEN_MATERIALS)
  }
}

let disposed = false

withTimeout(loadCarModels(), MODEL_TIMEOUT_MS, 'Loading the car models')
  .catch((error) => {
    // Any failure (a missing file, a corrupt file, a slow network) leaves the box cars in place.
    console.warn('Car model unavailable, using the built-in car instead:', error)
  })
  .then(async () => {
    if (disposed) return // the module was hot-reloaded while loading
    // Keys pressed during loading were queued by the input layer; drop them so the race doesn't start early.
    input.consumeConfirm()
    input.consumeReset()
    input.consumeCamera()
    input.consumePause()
    game.renderer.compile(game.scene, game.camera) // builds the shaders now, so the first frames don't hitch
    game.start()
    await loading.hide()
  })

// Avoid duplicate games and listeners when Vite hot-reloads this file.
import.meta.hot?.dispose(() => {
  disposed = true
  document.removeEventListener('visibilitychange', onVisibility)
  stopSettings()
  pauseMenu.dispose()
  loading.dispose()
  input.dispose()
  audio.dispose()
  minimap.dispose()
  viewLabel.dispose()
  hud.dispose()
  smoke.dispose()
  skidMarks.dispose()
  props.dispose()
  buildings.dispose()
  disposeFacadeStyles(facades)
  track.dispose()
  game.dispose()
})