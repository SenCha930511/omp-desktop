import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BrowserWindow, Rectangle } from 'electron'
import { isRecord } from './validation'

export interface WindowGeometry {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

export interface DisplayWorkArea {
  workArea: Rectangle
}

export const WINDOW_GEOMETRY_FILENAME = 'ui-geometry.json'
export const MIN_WINDOW_WIDTH = 960
export const MIN_WINDOW_HEIGHT = 640
const MAX_WINDOW_DIMENSION = 16_384
const MAX_GEOMETRY_FILE_BYTES = 64 * 1024
const MIN_VISIBLE_OVERLAP_WIDTH = 120
const MIN_VISIBLE_OVERLAP_HEIGHT = 80

export const DEFAULT_WINDOW_GEOMETRY: WindowGeometry = {
  width: 1440,
  height: 920,
  maximized: true,
}

export type GeometryTargetWindow = Pick<
  BrowserWindow,
  'on' | 'isDestroyed' | 'isMaximized' | 'isMinimized' | 'isFullScreen' | 'getBounds' | 'getNormalBounds'
>

function clampDimension(value: number, min: number, max = MAX_WINDOW_DIMENSION): number {
  return Math.max(min, Math.min(value, max))
}

function isRectVisibleOnDisplays(rect: Required<Pick<WindowGeometry, 'x' | 'y' | 'width' | 'height'>>, displays: ReadonlyArray<DisplayWorkArea>): boolean {
  const requiredWidth = Math.min(MIN_VISIBLE_OVERLAP_WIDTH, rect.width)
  const requiredHeight = Math.min(MIN_VISIBLE_OVERLAP_HEIGHT, rect.height)
  for (const { workArea } of displays) {
    const overlapWidth = Math.min(rect.x + rect.width, workArea.x + workArea.width) - Math.max(rect.x, workArea.x)
    const overlapHeight = Math.min(rect.y + rect.height, workArea.y + workArea.height) - Math.max(rect.y, workArea.y)
    if (overlapWidth >= requiredWidth && overlapHeight >= requiredHeight) return true
  }
  return false
}

/**
 * Loads saved window geometry synchronously for BrowserWindow construction,
 * validating dimensions against minimum bounds and dropping off-screen
 * coordinates when the display layout changes.
 */
export function readWindowGeometry(filePath: string, displays: ReadonlyArray<DisplayWorkArea>): WindowGeometry {
  try {
    if (statSync(filePath).size > MAX_GEOMETRY_FILE_BYTES) return { ...DEFAULT_WINDOW_GEOMETRY }
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!isRecord(raw)) return { ...DEFAULT_WINDOW_GEOMETRY }
    if (typeof raw.width !== 'number' || !Number.isSafeInteger(raw.width) || raw.width <= 0
      || typeof raw.height !== 'number' || !Number.isSafeInteger(raw.height) || raw.height <= 0) {
      return { ...DEFAULT_WINDOW_GEOMETRY }
    }
    let width = clampDimension(raw.width, MIN_WINDOW_WIDTH)
    let height = clampDimension(raw.height, MIN_WINDOW_HEIGHT)
    const result: WindowGeometry = { width, height }

    if (typeof raw.x === 'number' && Number.isSafeInteger(raw.x) && typeof raw.y === 'number' && Number.isSafeInteger(raw.y)) {
      if (displays.length === 0 || isRectVisibleOnDisplays({ x: raw.x, y: raw.y, width, height }, displays)) {
        result.x = raw.x
        result.y = raw.y
      } else {
        const primary = displays[0].workArea
        width = clampDimension(width, MIN_WINDOW_WIDTH, Math.max(MIN_WINDOW_WIDTH, primary.width))
        height = clampDimension(height, MIN_WINDOW_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, primary.height))
        result.width = width
        result.height = height
      }
    }

    if (raw.maximized === true) result.maximized = true
    return result
  } catch {
    return { ...DEFAULT_WINDOW_GEOMETRY }
  }
}

function readNormalBounds(window: GeometryTargetWindow): Rectangle {
  return window.getNormalBounds ? window.getNormalBounds() : window.getBounds()
}

async function writeAtomicGeometry(filePath: string, serialized: string): Promise<void> {
  mkdirSync(dirname(filePath), { recursive: true })
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, filePath)
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

/**
 * Tracks normal window bounds and maximized state, coalescing resize and move
 * bursts into a debounced atomic write to ui-geometry.json and flushing on close.
 */
export function bindWindowGeometryPersistence(
  window: GeometryTargetWindow,
  filePath: string,
  debounceMs = 300,
): { flush(): Promise<void>; dispose(): void } {
  let timer: NodeJS.Timeout | null = null
  let disposed = false
  let lastNormalBounds = readNormalBounds(window)
  let writeTail: Promise<void> = Promise.resolve()
  let lastWritten: string | null = null

  const snapshot = (): WindowGeometry => ({
    x: Math.round(lastNormalBounds.x),
    y: Math.round(lastNormalBounds.y),
    width: Math.max(MIN_WINDOW_WIDTH, Math.round(lastNormalBounds.width)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.round(lastNormalBounds.height)),
    maximized: window.isMaximized(),
  })

  const refreshNormalBounds = () => {
    if (window.isDestroyed()) return
    if (!window.isMaximized() && !window.isMinimized() && !window.isFullScreen()) {
      lastNormalBounds = readNormalBounds(window)
    }
  }

  const enqueueWrite = (geometry: WindowGeometry): Promise<void> => {
    const serialized = `${JSON.stringify(geometry, null, 2)}\n`
    if (serialized === lastWritten) return writeTail
    lastWritten = serialized
    const operation = writeTail.then(() => writeAtomicGeometry(filePath, serialized)).catch(() => {
      if (lastWritten === serialized) lastWritten = null
    })
    writeTail = operation
    return operation
  }

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (window.isDestroyed()) return writeTail
    refreshNormalBounds()
    return enqueueWrite(snapshot())
  }

  const schedule = () => {
    if (disposed || window.isDestroyed()) return
    refreshNormalBounds()
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!disposed && !window.isDestroyed()) void enqueueWrite(snapshot())
    }, debounceMs)
    timer.unref?.()
  }

  window.on('resize', schedule)
  window.on('move', schedule)
  window.on('maximize', schedule)
  window.on('unmaximize', schedule)
  window.on('close', () => { void flush() })

  return {
    flush,
    dispose() {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
