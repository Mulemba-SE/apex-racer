import * as THREE from 'three'

export type FacadeName = 'glass' | 'brick' | 'concrete' | 'stucco'

export const FACADE_NAMES: readonly FacadeName[] = ['glass', 'brick', 'concrete', 'stucco']

/** One wall style: a tiling texture, plus how big its bays and floors are in metres. */
export interface FacadeStyle {
  name: FacadeName
  texture: THREE.CanvasTexture
  bayWidth: number // metres of wall that one window bay covers
  floorHeight: number // metres of wall that one floor covers
  baysPerTile: number // bays across one repeat of the texture
  floorsPerTile: number // floors up one repeat of the texture
  /** A point in a plain, unpatterned part of the texture. Flat roofs are mapped to it, so they show one solid colour. */
  roofUV: readonly [number, number]
}

const SIZE = 512 // pixels per side of each texture
const CELLS = 4 // bays across and floors up one repeat
const CELL = SIZE / CELLS // 128 px per bay

type Ctx = CanvasRenderingContext2D
type Random = () => number

/** A small seeded random generator, so the textures come out the same on every load. */
function mulberry32(seed: number): Random {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`
}

/** Calls `draw` once for every bay of a tile, with the pixel position of its top-left corner. */
function eachCell(draw: (x0: number, y0: number) => void): void {
  for (let row = 0; row < CELLS; row++) {
    for (let col = 0; col < CELLS; col++) draw(col * CELL, row * CELL)
  }
}

// Every drawing below is made to tile: each bay draws its own left and top edge, and anything that
// spans a bay edge (a pane, a ribbon window) continues straight into its neighbour. That keeps the
// seams between repeats invisible.

function drawGlass(ctx: Ctx, rand: Random): void {
  ctx.fillStyle = '#3a444d' // the dark band under each floor, and the frame
  ctx.fillRect(0, 0, SIZE, SIZE)
  eachCell((x0, y0) => {
    // The glass pane: lighter at the top, deeper at the bottom, a little different in every bay.
    const hue = 200 + rand() * 16
    const light = 34 + rand() * 16
    const pane = ctx.createLinearGradient(0, y0 + 6, 0, y0 + 96)
    pane.addColorStop(0, hsl(hue, 40, light + 10))
    pane.addColorStop(1, hsl(hue, 45, light - 8))
    ctx.fillStyle = pane
    ctx.fillRect(x0 + 5, y0 + 6, CELL - 5, 90)

    // A pale reflection streak on some panes.
    if (rand() < 0.4) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.13)'
      ctx.beginPath()
      ctx.moveTo(x0 + 18, y0 + 96)
      ctx.lineTo(x0 + 52, y0 + 6)
      ctx.lineTo(x0 + 74, y0 + 6)
      ctx.lineTo(x0 + 40, y0 + 96)
      ctx.closePath()
      ctx.fill()
    }

    // Mullions: a pale vertical bar on the left of the bay and a thin horizontal one along the top.
    ctx.fillStyle = '#a3adb6'
    ctx.fillRect(x0, y0 + 2, 5, 94)
    ctx.fillRect(x0, y0 + 2, CELL, 4)
  })
}

function drawBrick(ctx: Ctx, rand: Random): void {
  ctx.fillStyle = '#a79c92' // mortar
  ctx.fillRect(0, 0, SIZE, SIZE)

  // Bricks 32 by 16 px with 2 px of mortar. Every second row is shifted by half a brick.
  for (let row = 0; row < SIZE / 16; row++) {
    const shift = row % 2 === 0 ? 0 : -16
    for (let k = 0; k <= SIZE / 32; k++) {
      const red = 150 + rand() * 28
      ctx.fillStyle = `rgb(${Math.round(red)}, ${Math.round(red * 0.46)}, ${Math.round(red * 0.36)})`
      ctx.fillRect(shift + k * 32 + 1, row * 16 + 1, 30, 14)
    }
  }

  eachCell((x0, y0) => {
    // A pale stone course between floors. This is also the plain area that roofs use.
    ctx.fillStyle = '#cdc6ba'
    ctx.fillRect(x0, y0 + 108, CELL, 16)

    // The window: a pale frame, dark glass, a cross of glazing bars, and a sill.
    ctx.fillStyle = '#e3ded4'
    ctx.fillRect(x0 + 36, y0 + 22, 56, 70)
    ctx.fillStyle = hsl(205, 30, 18 + rand() * 14)
    ctx.fillRect(x0 + 41, y0 + 27, 46, 60)
    ctx.fillStyle = '#e3ded4'
    ctx.fillRect(x0 + 62, y0 + 27, 4, 60)
    ctx.fillRect(x0 + 41, y0 + 55, 46, 4)
    ctx.fillStyle = '#b8b0a3'
    ctx.fillRect(x0 + 32, y0 + 92, 64, 6)
  })
}

function drawConcrete(ctx: Ctx, rand: Random): void {
  ctx.fillStyle = '#b4b4af'
  ctx.fillRect(0, 0, SIZE, SIZE)

  // A faint speckle, so the panels aren't perfectly flat.
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = rand() < 0.5 ? 'rgba(255, 255, 255, 0.07)' : 'rgba(0, 0, 0, 0.06)'
    ctx.fillRect(rand() * SIZE, rand() * SIZE, 2 + rand() * 4, 2 + rand() * 4)
  }

  eachCell((x0, y0) => {
    // A solid panel under each ribbon window. This is also the plain area that roofs use.
    ctx.fillStyle = '#a5a5a0'
    ctx.fillRect(x0, y0 + 90, CELL, 38)

    // The ribbon window runs the full width of the bay, so it continues into the next one.
    ctx.fillStyle = hsl(198 + rand() * 12, 30, 26 + rand() * 14)
    ctx.fillRect(x0, y0 + 16, CELL, 66)
    if (rand() < 0.3) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)'
      ctx.fillRect(x0 + 20, y0 + 16, 26, 66)
    }

    // A concrete pier between panes.
    ctx.fillStyle = '#b4b4af'
    ctx.fillRect(x0, y0 + 16, 8, 66)
  })
}

function drawStucco(ctx: Ctx, rand: Random): void {
  ctx.fillStyle = '#dccdaa'
  ctx.fillRect(0, 0, SIZE, SIZE)

  eachCell((x0, y0) => {
    // A darker floor line along the bottom of the bay.
    ctx.fillStyle = '#c9b88f'
    ctx.fillRect(x0, y0 + 118, CELL, 10)

    // The window: a white frame, dark glass, and one glazing bar.
    ctx.fillStyle = '#f4f1ea'
    ctx.fillRect(x0 + 40, y0 + 20, 48, 64)
    ctx.fillStyle = hsl(210, 28, 16 + rand() * 16)
    ctx.fillRect(x0 + 45, y0 + 25, 38, 54)
    ctx.fillStyle = '#f4f1ea'
    ctx.fillRect(x0 + 62, y0 + 25, 4, 54)

    // Shutters on some windows.
    if (rand() < 0.4) {
      ctx.fillStyle = hsl(150 + rand() * 20, 25, 32)
      ctx.fillRect(x0 + 28, y0 + 20, 10, 64)
      ctx.fillRect(x0 + 90, y0 + 20, 10, 64)
    }

    // A balcony rail on some: a top rail and six posts.
    if (rand() < 0.35) {
      ctx.fillStyle = '#3f3f3f'
      ctx.fillRect(x0 + 30, y0 + 88, 68, 5)
      for (let post = 0; post < 6; post++) ctx.fillRect(x0 + 32 + post * 12, y0 + 93, 3, 20)
    }
  })
}

interface Definition {
  seed: number
  draw: (ctx: Ctx, rand: Random) => void
  bayWidth: number // metres
  floorHeight: number // metres
  roofPixel: readonly [number, number] // a pixel inside a plain, flat part of the drawing
}

const DEFINITIONS: Record<FacadeName, Definition> = {
  glass: { seed: 1101, draw: drawGlass, bayWidth: 3.0, floorHeight: 3.6, roofPixel: [64, 500] },
  brick: { seed: 2202, draw: drawBrick, bayWidth: 3.2, floorHeight: 3.3, roofPixel: [64, 116] },
  concrete: { seed: 3303, draw: drawConcrete, bayWidth: 3.0, floorHeight: 3.4, roofPixel: [64, 110] },
  stucco: { seed: 4404, draw: drawStucco, bayWidth: 3.0, floorHeight: 3.0, roofPixel: [14, 60] },
}

/**
 * Draws all four wall styles. Call once, and share the result. `anisotropy` keeps the windows sharp at
 * a shallow angle, such as a long wall seen from the road. The GPU clamps it to what it supports.
 */
export function createFacadeStyles(anisotropy = 4): Record<FacadeName, FacadeStyle> {
  const styles = {} as Record<FacadeName, FacadeStyle>

  for (const name of FACADE_NAMES) {
    const def = DEFINITIONS[name]
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas is not available')
    def.draw(ctx, mulberry32(def.seed))

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.anisotropy = anisotropy

    styles[name] = {
      name,
      texture,
      bayWidth: def.bayWidth,
      floorHeight: def.floorHeight,
      baysPerTile: CELLS,
      floorsPerTile: CELLS,
      // Canvas y runs downward, but texture v runs upward, so the vertical coordinate is flipped.
      roofUV: [(def.roofPixel[0] + 0.5) / SIZE, 1 - (def.roofPixel[1] + 0.5) / SIZE],
    }
  }
  return styles
}

/** Texture coordinate units per metre of wall, across (u) and up (v). Used when the buildings are built. */
export function uPerMetre(style: FacadeStyle): number {
  return 1 / (style.bayWidth * style.baysPerTile)
}

export function vPerMetre(style: FacadeStyle): number {
  return 1 / (style.floorHeight * style.floorsPerTile)
}

/** Frees the GPU memory of the textures made by createFacadeStyles(). */
export function disposeFacadeStyles(styles: Record<FacadeName, FacadeStyle>): void {
  for (const name of FACADE_NAMES) styles[name].texture.dispose()
}