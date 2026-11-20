import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_GEOMETRY,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MAX_WINDOW_DIMENSION,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  parseWindowGeometry,
  resolveWindowBounds,
  WindowGeometryStore,
  type WindowGeometry,
} from '../../electron/main/window-geometry'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'omp-desktop-geometry-'))
  directories.push(directory)
  return directory
}

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 }
const SECONDARY = { x: 1920, y: 0, width: 1920, height: 1080 }

function geometry(patch: Partial<WindowGeometry> = {}): WindowGeometry {
  return { ...DEFAULT_WINDOW_GEOMETRY, ...patch }
}

describe('parseWindowGeometry', () => {
  it('falls back to the defaults for malformed values', () => {
    expect(parseWindowGeometry(null)).toEqual(DEFAULT_WINDOW_GEOMETRY)
    expect(parseWindowGeometry('window')).toEqual(DEFAULT_WINDOW_GEOMETRY)
    expect(parseWindowGeometry([])).toEqual(DEFAULT_WINDOW_GEOMETRY)
    expect(parseWindowGeometry({ x: 'left', y: Number.POSITIVE_INFINITY, width: 'wide', height: Number.NaN, maximized: 'yes' })).toEqual(DEFAULT_WINDOW_GEOMETRY)
    expect(parseWindowGeometry({ width: 0, height: -10 })).toEqual(DEFAULT_WINDOW_GEOMETRY)
  })

  it('keeps valid fields while clamping undersized and oversized dimensions', () => {
    expect(parseWindowGeometry({ x: 12, y: -8, width: 100, height: 50, maximized: true })).toEqual({
      x: 12,
      y: -8,
      width: MIN_WINDOW_WIDTH,
      height: MIN_WINDOW_HEIGHT,
      maximized: true,
    })
    expect(parseWindowGeometry({ width: 1_000_000, height: 1_000_000 })).toEqual({
      x: null,
      y: null,
      width: MAX_WINDOW_DIMENSION,
      height: MAX_WINDOW_DIMENSION,
      maximized: false,
    })
  })
})

describe('resolveWindowBounds', () => {
  it('centers the default window in the primary work area on first run', () => {
    expect(resolveWindowBounds(geometry(), [PRIMARY], PRIMARY)).toEqual({
      x: 240,
      y: 80,
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
    })
  })

  it('restores a saved rectangle that is on screen', () => {
    expect(resolveWindowBounds(geometry({ x: 100, y: 80, width: 1100, height: 760 }), [PRIMARY], PRIMARY)).toEqual({
      x: 100,
      y: 80,
      width: 1100,
      height: 760,
    })
  })

  it('restores a saved rectangle on a secondary display', () => {
    expect(resolveWindowBounds(geometry({ x: 2100, y: 120, width: 1100, height: 760 }), [PRIMARY, SECONDARY], PRIMARY)).toEqual({
      x: 2100,
      y: 120,
      width: 1100,
      height: 760,
    })
  })

  it('prefers the primary work area when overlaps tie', () => {
    const left = { x: -800, y: 0, width: 800, height: 1080 }
    const right = { x: 0, y: 0, width: 800, height: 1080 }
    expect(resolveWindowBounds(geometry({ x: -550, y: 100, width: 1100, height: 760 }), [left, right], right)).toMatchObject({ x: 0, y: 100 })
  })

  it('recenters a fully off-screen rectangle in the primary work area', () => {
    expect(resolveWindowBounds(geometry({ x: 5000, y: 4000, width: 1100, height: 760 }), [PRIMARY], PRIMARY)).toEqual({
      x: 410,
      y: 160,
      width: 1100,
      height: 760,
    })
  })

  it('clamps a partially off-screen rectangle back into the visible work area', () => {
    expect(resolveWindowBounds(geometry({ x: 1500, y: 900, width: 1100, height: 760 }), [PRIMARY], PRIMARY)).toEqual({
      x: 820,
      y: 320,
      width: 1100,
      height: 760,
    })
  })

  it('never returns a window larger than the work area', () => {
    expect(resolveWindowBounds(geometry({ x: 0, y: 0, width: 3000, height: 2000 }), [PRIMARY], PRIMARY)).toEqual({
      x: 0,
      y: 0,
      width: PRIMARY.width,
      height: PRIMARY.height,
    })
  })
})

describe('WindowGeometryStore', () => {
  it('reads the default when the file is missing', () => {
    const store = new WindowGeometryStore(join(tempDir(), 'nested', 'ui-geometry.json'))
    expect(store.read()).toEqual({ version: 1, window: DEFAULT_WINDOW_GEOMETRY })
  })

  it('reads the default when the file is corrupt', () => {
    const directory = tempDir()
    const filePath = join(directory, 'ui-geometry.json')
    writeFileSync(filePath, '{"version":1,"window":{"width":')
    expect(new WindowGeometryStore(filePath).read()).toEqual({ version: 1, window: DEFAULT_WINDOW_GEOMETRY })
    writeFileSync(filePath, JSON.stringify({ version: 1, window: { width: 'wide', height: null, maximized: 1 } }))
    expect(new WindowGeometryStore(filePath).read()).toEqual({ version: 1, window: DEFAULT_WINDOW_GEOMETRY })
  })

  it('reads the default when the file exceeds the size cap', () => {
    const directory = tempDir()
    const filePath = join(directory, 'ui-geometry.json')
    writeFileSync(filePath, 'x'.repeat(64 * 1024 + 1))
    expect(new WindowGeometryStore(filePath).read()).toEqual({ version: 1, window: DEFAULT_WINDOW_GEOMETRY })
  })

  it('round-trips a saved geometry and leaves no temp file behind', async () => {
    const directory = tempDir()
    const filePath = join(directory, 'ui-geometry.json')
    const store = new WindowGeometryStore(filePath)
    const saved = geometry({ x: 40, y: 50, width: 1100, height: 760 })

    await store.save(saved)

    expect(store.read()).toEqual({ version: 1, window: saved })
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ version: 1, window: saved })
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it('serializes concurrent saves so the last one wins', async () => {
    const directory = tempDir()
    mkdirSync(directory, { recursive: true })
    const filePath = join(directory, 'ui-geometry.json')
    const store = new WindowGeometryStore(filePath)
    const first = geometry({ x: 10, y: 20, width: 1000, height: 700 })
    const second = geometry({ x: 30, y: 40, width: 1200, height: 800 })

    await Promise.all([store.save(first), store.save(second)])

    expect(store.read()).toEqual({ version: 1, window: second })
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
