import { EventEmitter } from 'node:events'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DownloadItem, Event, WebContents } from 'electron'
import { automaticDownloadPath, BrowserDownloadGuard } from '../../electron/main/browser-downloads'

class FakeDownload extends EventEmitter {
  received = 0
  cancelled = false
  saveOptions: unknown
  savePath: string | undefined
  constructor(readonly url: string, readonly total = 1024, readonly gesture = true) { super() }
  getURLChain() { return [this.url] }
  getURL() { return this.url }
  getTotalBytes() { return this.total }
  hasUserGesture() { return this.gesture }
  getFilename() { return 'download.bin' }
  setSaveDialogOptions(options: unknown) { this.saveOptions = options }
  setSavePath(path: string) { this.savePath = path }
  getReceivedBytes() { return this.received }
  cancel() { this.cancelled = true }
}

const allowed = (value: string) => /^https?:\/\//.test(value)
const owner = { id: 7, isDestroyed: () => false } as WebContents
const event = () => ({ preventDefault: vi.fn() }) as unknown as Event & { preventDefault: ReturnType<typeof vi.fn> }

describe('BrowserDownloadGuard', () => {
  it('denies unsafe, gestureless, and oversized downloads', () => {
    const guard = new BrowserDownloadGuard(allowed, '/safe-downloads')
    for (const item of [new FakeDownload('file:///etc/passwd'), new FakeDownload('https://example.test/a', 10, false), new FakeDownload('https://example.test/a', 513 * 1024 * 1024)]) {
      const requested = event(); guard.handle(requested, item as unknown as DownloadItem, owner, true); expect(requested.preventDefault).toHaveBeenCalledOnce()
    }
  })

  it('saves to a unique safe default destination when prompting is disabled', () => {
    const downloadDirectory = resolve('safe-downloads')
    const guard = new BrowserDownloadGuard(allowed, downloadDirectory)
    const item = new FakeDownload('https://example.test/a')
    const requested = event()
    guard.handle(requested, item as unknown as DownloadItem, owner, false)

    expect(requested.preventDefault).not.toHaveBeenCalled()
    expect(item.saveOptions).toBeUndefined()
    const savePath = item.savePath ?? ''
    expect(savePath).not.toBe('')
    expect(dirname(savePath)).toBe(downloadDirectory)
    expect(basename(savePath)).toMatch(/^download-[0-9a-f-]+\.bin$/)
    expect(automaticDownloadPath(downloadDirectory, '../../escape.txt', 'unique')).toBe(join(downloadDirectory, 'escape-unique.txt'))
  })

  it('caps concurrent downloads and cancels every item owned by a destroyed guest', () => {
    const guard = new BrowserDownloadGuard(allowed, '/safe-downloads')
    const items = Array.from({ length: 4 }, (_, index) => new FakeDownload(`https://example.test/${index}`))
    for (const item of items.slice(0, 3)) guard.handle(event(), item as unknown as DownloadItem, owner, true)
    const fourth = event(); guard.handle(fourth, items[3] as unknown as DownloadItem, owner, true)
    expect(fourth.preventDefault).toHaveBeenCalledOnce(); expect(guard.activeCount).toBe(3)
    guard.cancelOwner(owner.id); expect(items.slice(0, 3).every((item) => item.cancelled)).toBe(true)
  })

  it('charges declared totals at admission and refunds unreceived bytes on completion', () => {
    const MB = 1024 * 1024
    const guard = new BrowserDownloadGuard(allowed, '/safe-downloads')
    const first = new FakeDownload('https://example.test/first', 500 * MB)
    guard.handle(event(), first as unknown as DownloadItem, owner, true)
    const second = new FakeDownload('https://example.test/second', 500 * MB)
    guard.handle(event(), second as unknown as DownloadItem, owner, true)

    // Nothing has been received yet, but the declared totals no longer fit together.
    const third = new FakeDownload('https://example.test/third', 100 * MB)
    const denied = event()
    guard.handle(denied, third as unknown as DownloadItem, owner, true)
    expect(denied.preventDefault).toHaveBeenCalledOnce()

    // The first download finishes early: actual bytes replace the declared charge.
    first.received = 100 * MB
    first.emit('updated')
    first.emit('done')

    const fourth = new FakeDownload('https://example.test/fourth', 400 * MB)
    const admitted = event()
    guard.handle(admitted, fourth as unknown as DownloadItem, owner, true)
    expect(admitted.preventDefault).not.toHaveBeenCalled()

    const fifth = new FakeDownload('https://example.test/fifth', 100 * MB)
    const overBudget = event()
    guard.handle(overBudget, fifth as unknown as DownloadItem, owner, true)
    expect(overBudget.preventDefault).toHaveBeenCalledOnce()
  })

  it('cancels a streaming download that crosses the per-item byte cap', () => {
    const guard = new BrowserDownloadGuard(allowed, '/safe-downloads')
    const item = new FakeDownload('https://example.test/chunked', -1)
    guard.handle(event(), item as unknown as DownloadItem, owner, true)
    item.received = 512 * 1024 * 1024 + 1; item.emit('updated')
    expect(item.cancelled).toBe(true)
  })
})
