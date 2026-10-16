import { describe, expect, it } from 'vitest'
import { OMP_RPC_ADAPTER } from '../../electron/main/agent-rpc'
import { parseSessionActionSnapshot } from '../../src/lib/session-actions'

describe('OMP steering protocol parity', () => {
  it('passes steer commands through the shared RPC vocabulary', () => {
    const command = { type: 'steer', message: 'change direction' }
    expect(OMP_RPC_ADAPTER.translateCommand(command)).toBe(command)
  })

  it('preserves the existing image payload for prompts and steers', () => {
    const images = [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }]
    const steer = { type: 'steer', message: 'inspect this instead', images }

    expect(OMP_RPC_ADAPTER.translateCommand(steer)).toBe(steer)
    const prompt = { type: 'prompt', message: 'inspect', images, streamingBehavior: 'steer' }
    const translated = OMP_RPC_ADAPTER.translateCommand(prompt)
    expect(translated).not.toBe(prompt)
    expect(translated).not.toHaveProperty('streamingBehavior')
    expect(translated).toMatchObject({ type: 'prompt', message: 'inspect', images })
  })

  it('preserves both queued and picked-up session action snapshots', () => {
    const queued = {
      type: 'session_action_update',
      actions: { queuedCount: 1, steering: ['change direction'], followUps: [] },
    }
    const pickedUp = {
      type: 'session_action_update',
      actions: {
        queuedCount: 0,
        steering: [],
        followUps: [],
        active: { kind: 'turn', phase: 'preparing', label: 'change direction' },
      },
    }

    const normalizedQueued = OMP_RPC_ADAPTER.normalizeEvent(queued)
    const normalizedPickedUp = OMP_RPC_ADAPTER.normalizeEvent(pickedUp)
    expect(normalizedQueued).toBe(queued)
    expect(normalizedPickedUp).toBe(pickedUp)
    expect(parseSessionActionSnapshot(normalizedQueued?.actions)).toEqual(queued.actions)
    expect(parseSessionActionSnapshot(normalizedPickedUp?.actions)).toEqual(pickedUp.actions)
  })
})
