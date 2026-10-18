import { describe, expect, it } from 'vitest'
import { searchTranscript } from '../../src/lib/transcript-search'
import { failedTurn } from '../../src/components/TurnRecovery'
import type { TranscriptMessage } from '../../src/types/api'

const message = (id: string, role: TranscriptMessage['role'], text: string): TranscriptMessage => ({ id, role, parts: [{ type: 'text', text }] })

describe('conversation search and recovery', () => {
  it('searches older history, tool arguments and reasoning by scope without duplicate message results', () => {
    const messages = Array.from({ length: 1000 }, (_, index) => message(String(index), index % 2 ? 'assistant' : 'user', index === 0 ? 'Older needle' : 'Recent text'))
    messages[999].parts.push({ type: 'thinking', text: 'Needle analysis' }, { type: 'toolCall', id: 'call', name: 'bash', args: { command: 'needle command' } }, { type: 'toolResult', partId: 'call', text: 'needle result' })
    expect(searchTranscript(messages, ' NEEDLE ', 'all')).toEqual(['0', '999'])
    expect(searchTranscript(messages, 'needle', 'messages')).toEqual(['0'])
    expect(searchTranscript(messages, 'needle', 'thinking')).toEqual(['999'])
    expect(searchTranscript(messages, 'needle command', 'tools')).toEqual(['999'])
    expect(searchTranscript(messages, ' ', 'all')).toEqual([])
  })

  it('offers recovery only for the latest failed turn and preserves its user prompt', () => {
    const messages = [message('user', 'user', 'Original prompt'), message('error:1', 'system', 'Provider rejected the request')]
    expect(failedTurn(messages)).toEqual({ error: 'Provider rejected the request', prompt: 'Original prompt' })
    expect(failedTurn([...messages, message('next', 'user', 'Next prompt')])).toBeUndefined()
    expect(failedTurn([])).toBeUndefined()
  })
})
