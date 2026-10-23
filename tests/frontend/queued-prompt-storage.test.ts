// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ensureLocalStorage } from './storage-fixture'
import { readPendingQueues, savePendingQueues } from '../../src/lib/queued-prompt-storage'

beforeEach(ensureLocalStorage)
afterEach(() => window.localStorage.clear())

it('restores local queued requests with their owner and requires explicit retry', () => {
  savePendingQueues(new Map([['omp:session:/a', [{ id: 'q1', text: 'preserve', timestamp: 1, intent: 'queue' }]]]))
  expect(readPendingQueues().get('omp:session:/a')).toEqual([{ id: 'q1', text: 'preserve', timestamp: 1, intent: 'queue', flushAttemptFailed: true, recovered: true }])
  expect(readPendingQueues().has('omp:session:/b')).toBe(false)
})

it('does not persist steers that may already have been delivered', () => {
  savePendingQueues(new Map([['owner', [{ id: 's1', text: 'steer', timestamp: 1, intent: 'steer' }]]]))
  expect(readPendingQueues().size).toBe(0)
})

it('ignores corrupt storage and removes acknowledged queue entries', () => {
  window.localStorage.setItem('omp-desktop.pending-queue.v1', '{bad')
  expect(readPendingQueues().size).toBe(0)
  savePendingQueues(new Map([['owner', [{ id: 'q1', text: 'x', timestamp: 1, intent: 'queue' }]]]))
  savePendingQueues(new Map())
  expect(readPendingQueues().size).toBe(0)
})
