import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindWindowGeometryPersistence,
  DEFAULT_WINDOW_GEOMETRY,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  readWindowGeometry,
  type DisplayWorkArea,
  type GeometryTargetWindow,
} from '../../electron/main/window-geometry'

const dirs: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempGeometryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-geometry-'))
  dirs.push(dir)
  return join(dir, 'ui-geometry.json')
}

const primaryDisplay: DisplayWorkArea = {
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
}

class FakeWindow extends EventEmitter {
  bounds = { x: 100, y: 80, width: 1280, height: 820 }
  normalBounds = { x: 100, y: 80, width: 1280, height: 820 }
  maximized = false
  minimized = false
  fullScreen = false
  destroyed = false

  isDestroyed() { return this.destroyed }
  isMaximized() { return this.maximized }
  isMinimized() { return this.minimized }
  isFullScreen() { return this.fullScreen }
  getBounds() { return { ...this.bounds } }
  getNormalBounds() { return { ...this.normalBounds } }
}

describe('readWindowGeometry', () => {
  it('returns the default geometry when the file is missing or corrupt', () => {
    const missingPath = tempGeometryPath()
    expect(readWindowGeometry(missingPath, [primaryDisplay])).toEqual(DEFAULT_WINDOW_GEOMETRY)

    writeFileSync(missingPath, '{not valid json')
    expect(readWindowGeometry(missingPath, [primaryDisplay])).toEqual(DEFAULT_WINDOW_GEOMETRY)

    writeFileSync(missingPath, JSON.stringify({ width: '1200', height: 900 }))
    expect(readWindowGeometry(missingPath, [primaryDisplay])).toEqual(DEFAULT_WINDOW_GEOMETRY)
  })

  it('restores valid geometry and clamps dimensions to minimum bounds', () => {
    const filePath = tempGeometryPath()
    writeFileSync(filePath, JSON.stringify({ x: 120, y: 90, width: 1500, height: 940, maximized: true }))
    expect(readWindowGeometry(filePath, [primaryDisplay])).toEqual({
      x: 120,
      y: 90,
      width: 1500,
      height: 940,
      maximized: true,
    })

    writeFileSync(filePath, JSON.stringify({ x: 40, y: 40, width: 500, height: 400 }))
    expect(readWindowGeometry(filePath, [primaryDisplay])).toEqual({
      x: 40,
      y: 40,
      width: MIN_WINDOW_WIDTH,
      height: MIN_WINDOW_HEIGHT,
    })
  })

  it('drops off-screen coordinates and clamps dimensions to the primary display', () => {
    const filePath = tempGeometryPath()
    const compactDisplay: DisplayWorkArea = { workArea: { x: 0, y: 0, width: 1280, height: 800 } }
    writeFileSync(filePath, JSON.stringify({ x: 2560, y: 120, width: 1600, height: 1000, maximized: false }))

    expect(readWindowGeometry(filePath, [compactDisplay])).toEqual({
      width: 1280,
      height: 800,
    })
  })
})

describe('bindWindowGeometryPersistence', () => {
  it('coalesces rapid resize and move events into one debounced atomic write and preserves normal bounds when maximized', async () => {
    vi.useFakeTimers()
    const filePath = tempGeometryPath()
    const window = new FakeWindow()
    const controller = bindWindowGeometryPersistence(window as unknown as GeometryTargetWindow, filePath, 300)

    window.normalBounds = { x: 140, y: 100, width: 1300, height: 860 }
    window.bounds = { ...window.normalBounds }
    window.emit('resize')
    window.normalBounds = { x: 220, y: 140, width: 1360, height: 880 }
    window.bounds = { ...window.normalBounds }
    window.emit('move')

    await vi.advanceTimersByTimeAsync(299)
    expect(() => readFileSync(filePath, 'utf8')).toThrow()

    await vi.advanceTimersByTimeAsync(1)
    await controller.flush()
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      x: 220,
      y: 140,
      width: 1360,
      height: 880,
      maximized: false,
    })

    // Maximizing keeps the last normal bounds rather than writing the zoomed frame.
    window.maximized = true
    window.bounds = { x: 0, y: 0, width: 1920, height: 1080 }
    window.emit('maximize')
    window.emit('close')
    await controller.flush()
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      x: 220,
      y: 140,
      width: 1360,
      height: 880,
      maximized: true,
    })
    controller.dispose()
  })
})
