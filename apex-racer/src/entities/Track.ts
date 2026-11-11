import * as THREE from 'three'
import { BARRIER_MARGIN, type TrackData } from '@/entities/TrackData'

const KERB_WIDTH = 1.2
const KERB_HEIGHT = 0.03
const BARRIER_HEIGHT = 1.0
const BARRIER_THICKNESS = 0.5
const ROAD_TILE = 24 // metres of road per texture repeat (one centre dash each)
const KERB_TILE = 4 // metres per red-and-white pair

type Edge = readonly [lateral: number, height: number] // sideways offset from the centre line, and y
type Segment = readonly [Edge, Edge] // one flat strip running along the whole track

/**
 * Builds a strip that follows the track between two edges, for every segment given.
 * Each segment gets its own vertices, so corners (like the top of a barrier) stay sharp.
 * UVs: u runs 0..1 across the strip, v runs 0..vTiles along the track.
 */
function buildRibbon(
  data: TrackData,
  segments: readonly Segment[],
  vTiles: number,
): THREE.BufferGeometry {
  const count = data.samples.length
  const rings = count + 1 // the last ring repeats the first, so the texture closes cleanly
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  segments.forEach(([a, b], s) => {
    const base = s * rings * 2
    for (let i = 0; i < rings; i++) {
      const sample = data.sampleAt(i)
      const v = (i / count) * vTiles
      for (let k = 0; k < 2; k++) {
        const edge = k === 0 ? a : b
        positions.push(
          sample.position.x + sample.right.x * edge[0],
          edge[1],
          sample.position.z + sample.right.z * edge[0],
        )
        uvs.push(k, v)
      }
    }
    for (let i = 0; i < count; i++) {
      const p = base + i * 2 // p, p+1 = this ring's two edges; p+2, p+3 = the next ring's
      indices.push(p, p + 1, p + 2, p + 1, p + 3, p + 2) // winding gives upward-facing normals
    }
  })

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

// Textures are drawn on a canvas, so the project needs no image files.

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas is not available')
  return [canvas, ctx]
}

function toTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapT = THREE.RepeatWrapping // v repeats along the track
  texture.anisotropy = 8 // keeps the lines sharp at a shallow angle (the GPU clamps this)
  return texture
}

function roadTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256, 512)
  ctx.fillStyle = '#3a3a3f'
  ctx.fillRect(0, 0, 256, 512)
  for (let i = 0; i < 6000; i++) {
    const shade = 40 + Math.floor(Math.random() * 40)
    ctx.fillStyle = `rgb(${shade}, ${shade}, ${shade + 4})`
    ctx.fillRect(Math.random() * 256, Math.random() * 512, 2, 2)
  }
  ctx.fillStyle = '#e8e8e8'
  ctx.fillRect(10, 0, 6, 512) // left edge line
  ctx.fillRect(240, 0, 6, 512) // right edge line
  ctx.fillRect(125, 0, 6, 170) // centre dash, a third of each tile
  return toTexture(canvas)
}

function kerbTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(16, 64)
  ctx.fillStyle = '#c8102e'
  ctx.fillRect(0, 0, 16, 32)
  ctx.fillStyle = '#f2f2f2'
  ctx.fillRect(0, 32, 16, 32)
  return toTexture(canvas)
}

function checkerTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(128, 32)
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 8; col++) {
      ctx.fillStyle = (row + col) % 2 === 0 ? '#111111' : '#f5f5f5'
      ctx.fillRect(col * 16, row * 16, 16, 16)
    }
  }
  return toTexture(canvas)
}

export class Track {
  /** Add this to the scene. */
  readonly object = new THREE.Group()
  readonly data: TrackData

  constructor(data: TrackData) {
    this.data = data
    const h = data.halfWidth
    const off = h + BARRIER_MARGIN
    const H = BARRIER_HEIGHT
    const T = BARRIER_THICKNESS

    // Road
    this.addMesh(
      buildRibbon(data, [[[-h, 0], [h, 0]]], Math.round(data.length / ROAD_TILE)),
      new THREE.MeshStandardMaterial({ map: roadTexture(), roughness: 0.95 }),
      { cast: false, receive: true },
    )

    // Kerbs, one strip on each side of the road
    this.addMesh(
      buildRibbon(
        data,
        [
          [[-h - KERB_WIDTH, KERB_HEIGHT], [-h, KERB_HEIGHT]],
          [[h, KERB_HEIGHT], [h + KERB_WIDTH, KERB_HEIGHT]],
        ],
        Math.round(data.length / KERB_TILE),
      ),
      new THREE.MeshStandardMaterial({
        map: kerbTexture(),
        roughness: 0.7,
        polygonOffset: true, // pulls the kerb toward the camera to prevent flicker on the road
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
      { cast: false, receive: true },
    )

    // Barriers: inner face, top, and outer face, on both sides
    this.addMesh(
      buildRibbon(
        data,
        [
          [[off, 0], [off, H]],
          [[off, H], [off + T, H]],
          [[off + T, H], [off + T, 0]],
          [[-off, 0], [-off, H]],
          [[-off, H], [-off - T, H]],
          [[-off - T, H], [-off - T, 0]],
        ],
        1,
      ),
      new THREE.MeshStandardMaterial({
        color: 0xc9ced6,
        roughness: 0.8,
        side: THREE.DoubleSide, // visible from both sides without worrying about winding
      }),
      { cast: true, receive: true },
    )

    this.buildStartLine()
  }

  dispose(): void {
    this.object.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const material = o.material as THREE.MeshStandardMaterial
        material.map?.dispose()
        material.dispose()
      }
    })
    this.object.removeFromParent()
  }

  private addMesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    shadows: { cast: boolean; receive: boolean },
  ): void {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.castShadow = shadows.cast
    mesh.receiveShadow = shadows.receive
    this.object.add(mesh)
  }

  /** Checkered line plus a gantry over the road at distance 0. */
  private buildStartLine(): void {
    const data = this.data
    const pose = data.poseAt(0)

    // Local axes of this group: +X is right, -Z is forward, like the car.
    const group = new THREE.Group()
    group.position.set(pose.x, 0, pose.z)
    group.rotation.y = pose.heading

    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(data.width, 2),
      new THREE.MeshStandardMaterial({
        map: checkerTexture(),
        roughness: 0.8,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    )
    line.rotation.x = -Math.PI / 2
    line.position.y = 0.02
    line.receiveShadow = true
    group.add(line)

    const postX = data.halfWidth + 2 // between the kerb and the barrier
    const postMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2d33, roughness: 0.6 })
    const postGeometry = new THREE.BoxGeometry(0.6, 7, 0.6)
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(postGeometry, postMaterial)
      post.position.set(side * postX, 3.5, 0)
      post.castShadow = true
      group.add(post)
    }

    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(postX * 2 + 0.6, 1.2, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xd62828, roughness: 0.5 }),
    )
    beam.position.set(0, 6.6, 0)
    beam.castShadow = true
    group.add(beam)

    this.object.add(group)
  }
}