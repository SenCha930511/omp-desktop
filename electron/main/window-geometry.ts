import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isRecord } from './validation'

/** Panel widths will share this file, so the shape is versioned. */
export const UI_GEOMETRY_FILENAME = 'ui-geometry.json'

export const MIN_WINDOW_WIDTH = 960
export const MIN_WINDOW_HEIGHT = 640
export const DEFAULT_WINDOW_WIDTH = 1440
export const DEFAULT_WINDOW_HEIGHT = 920

/**
 * Screen coordinates are signed 16-bit on Windows, and nothing larger is a
 * real display, so a corrupt or hostile file cannot ask for a window that the
 * platform would clamp anyway.
 */
export const MAX_WINDOW_DIMENSION = 32767

const MAX_GEOMETRY_FILE_BYTES = 64 * 1024

/** A display work area, kept independent of Electron so the clamp stays testable. */
export interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowGeometry {
  x: number | null
  y: number | null
  width: number
  height: number
  maximized: boolean
}

export interface UiGeometry {
  version: 1
  window: WindowGeometry
}

export const DEFAULT_WINDOW_GEOMETRY: WindowGeometry = Object.freeze({
  x: null,
  y: null,
  width: DEFAULT_WINDOW_WIDTH,
  height: DEFAULT_WINDOW_HEIGHT,
  maximized: false,
})

const MIN_VISIBLE_OVERLAP = 64

function defaultWindowGeometry(): WindowGeometry {
  return { ...DEFAULT_WINDOW_GEOMETRY }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampDimension(value: unknown, minimum: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.max(Math.round(value), minimum), MAX_WINDOW_DIMENSION)
}

export function parseWindowGeometry(value: unknown): WindowGeometry {
  if (!isRecord(value)) return defaultWindowGeometry()
  return {
    x: finiteOrNull(value.x),
    y: finiteOrNull(value.y),
    width: clampDimension(value.width, MIN_WINDOW_WIDTH, DEFAULT_WINDOW_WIDTH),
    height: clampDimension(value.height, MIN_WINDOW_HEIGHT, DEFAULT_WINDOW_HEIGHT),
    maximized: typeof value.maximized === 'boolean' ? value.maximized : DEFAULT_WINDOW_GEOMETRY.maximized,
  }
}

function overlap(saved: Rectangle, workArea: Rectangle): number {
  const width = Math.min(saved.x + saved.width, workArea.x + workArea.width) - Math.max(saved.x, workArea.x)
  const height = Math.min(saved.y + saved.height, workArea.y + workArea.height) - Math.max(saved.y, workArea.y)
  return width < MIN_VISIBLE_OVERLAP || height < MIN_VISIBLE_OVERLAP ? 0 : width * height
}

function sameRectangle(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

function visibleWorkArea(saved: Rectangle, workAreas: readonly Rectangle[], primary: Rectangle): Rectangle | null {
  let best: Rectangle | null = null
  let bestOverlap = 0
  for (const workArea of workAreas) {
    const area = overlap(saved, workArea)
    if (area > bestOverlap || (area === bestOverlap && area > 0 && sameRectangle(workArea, primary))) {
      best = workArea
      bestOverlap = area
    }
  }
  return best
}

function centeredIn(workArea: Rectangle, width: number, height: number): Rectangle {
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  }
}

export function resolveWindowBounds(geometry: WindowGeometry, workAreas: readonly Rectangle[], primary: Rectangle): Rectangle {
  const saved: Rectangle = {
    x: geometry.x ?? 0,
    y: geometry.y ?? 0,
    width: geometry.width,
    height: geometry.height,
  }
  const target = geometry.x === null || geometry.y === null ? null : visibleWorkArea(saved, workAreas, primary)
  const workArea = target ?? primary
  const width = Math.min(Math.max(Math.round(geometry.width), MIN_WINDOW_WIDTH), workArea.width)
  const height = Math.min(Math.max(Math.round(geometry.height), MIN_WINDOW_HEIGHT), workArea.height)
  if (!target) return centeredIn(workArea, width, height)
  return {
    x: Math.min(Math.max(Math.round(saved.x), workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(Math.round(saved.y), workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  }
}

/**
 * Synchronous read, queued atomic writes: the main process asks for geometry
 * while it is already constructing the window, and every save has to survive
 * a crash mid-write without ever leaving a half-written file behind.
 */
export class WindowGeometryStore {
  private readonly filePath: string
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /** Missing or malformed files are ordinary first-run conditions, never errors. */
  read(): UiGeometry {
    try {
      if (statSync(this.filePath).size > MAX_GEOMETRY_FILE_BYTES) return { version: 1, window: defaultWindowGeometry() }
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (!isRecord(parsed) || parsed.version !== 1) return { version: 1, window: defaultWindowGeometry() }
      return { version: 1, window: parseWindowGeometry(parsed.window) }
    } catch {
      return { version: 1, window: defaultWindowGeometry() }
    }
  }

  save(geometry: WindowGeometry): Promise<void> {
    const snapshot: UiGeometry = { version: 1, window: { ...geometry } }
    const operation = this.saveQueue.catch(() => undefined).then(() => this.write(snapshot))
    this.saveQueue = operation.catch(() => undefined)
    return operation
  }

  private async write(snapshot: UiGeometry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'w', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(snapshot)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, this.filePath)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}
