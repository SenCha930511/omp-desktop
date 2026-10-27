import { describe, expect, it } from 'vitest'
import {
  contentText,
  customActivityName,
  customMessageShape,
  imagePartsFromResult,
  MAX_PART_IMAGE_CHARS,
  MAX_UNSUPPORTED_DATA_CHARS,
  supplementaryPartsFromResult,
  unsupportedPartFromBlock,
} from '../../src/lib/events/message-content'

describe('contentText', () => {
  it('passes strings through and joins text/thinking blocks from arrays', () => {
    expect(contentText('plain')).toBe('plain')
    expect(contentText([
      { type: 'text', text: 'first' },
      { type: 'thinking', thinking: 'inner' },
      { type: 'image', data: 'x' },
      { type: 'text', text: 'second' },
    ])).toBe('first\ninner\nsecond')
  })

  it('reads wrapper records in output/text/content order', () => {
    expect(contentText({ output: 'out', text: 'txt' })).toBe('out')
    expect(contentText({ text: 'txt' })).toBe('txt')
    expect(contentText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
  })

  it('stringifies plain objects readably and returns empty for scalars', () => {
    expect(contentText({ status: 'ok' })).toBe('{\n  "status": "ok"\n}')
    expect(contentText(42)).toBe('')
    expect(contentText(null)).toBe('')
    expect(contentText(undefined)).toBe('')
  })
})

describe('customMessageShape', () => {
  it('maps agent_message to an agentMessage shape with the session name', () => {
    expect(customMessageShape({ customType: 'agent_message', details: { message: 'ready', from: { sessionName: 'Planner' } } }))
      .toEqual({ kind: 'agentMessage', text: 'ready', agentName: 'Planner' })
  })

  it('extracts array content for agent messages like the persisted reader (GAP 4)', () => {
    expect(customMessageShape({
      customType: 'agent_message',
      content: [{ type: 'text', text: 'first line' }, { type: 'image', data: 'x' }, { type: 'text', text: 'second line' }],
    })).toEqual({ kind: 'agentMessage', text: 'first line\nsecond line', agentName: undefined })
  })

  it('maps goal_context to a goal shape preferring the objective over the envelope', () => {
    expect(customMessageShape({
      customType: 'goal_context',
      content: '<goal_context>envelope</goal_context>',
      details: { objective: 'Ship it.' },
    })).toEqual({ kind: 'goal', text: 'Ship it.' })
  })

  it('maps other customTypes to named activity shapes (GAP 1)', () => {
    expect(customMessageShape({ customType: 'ipython_state_restored', content: 'Kernel state restored.' }))
      .toEqual({ kind: 'activity', name: 'IPython State Restored', text: 'Kernel state restored.' })
    expect(customMessageShape({ customType: 'weather_widget', content: 'Sunny' }))
      .toEqual({ kind: 'activity', name: 'Weather Widget', text: 'Sunny' })
    expect(customMessageShape({ content: 'no type' }))
      .toEqual({ kind: 'activity', name: 'Activity', text: 'no type' })
  })

  it('leaves compaction outcomes to the compaction path', () => {
    expect(customMessageShape({ customType: 'compaction_outcome' })).toBeUndefined()
  })
})

describe('customActivityName', () => {
  it('title-cases words, uppercases ipython, and falls back to Activity', () => {
    expect(customActivityName('session_note')).toBe('Session Note')
    expect(customActivityName('')).toBe('Activity')
  })
})

describe('imagePartsFromResult', () => {
  it('extracts image blocks from bare arrays and content wrappers (GAP 2)', () => {
    const fromArray = imagePartsFromResult([{ type: 'text', text: 't' }, { type: 'image', mimeType: 'image/png', data: 'aXY=' }])
    const fromWrapper = imagePartsFromResult({ content: [{ type: 'image', mimeType: 'image/jpeg', data: 'anBn' }] })
    expect(fromArray).toEqual([{ type: 'image', mimeType: 'image/png', data: 'aXY=', dataTruncated: undefined }])
    expect(fromWrapper).toEqual([{ type: 'image', mimeType: 'image/jpeg', data: 'anBn', dataTruncated: undefined }])
    expect(imagePartsFromResult('plain')).toEqual([])
  })

  it('marks oversized payloads as truncated like the persisted reader', () => {
    const [image] = imagePartsFromResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'x'.repeat(MAX_PART_IMAGE_CHARS + 8) }] })
    expect(image?.dataTruncated).toBe(true)
    expect(image?.data?.length).toBeLessThanOrEqual(MAX_PART_IMAGE_CHARS)
  })
})

describe('unsupportedPartFromBlock（階段 6.2：無 adapter 型別的資料視圖）', () => {
  it('keeps the block type and the original pretty-printed data', () => {
    const part = unsupportedPartFromBlock({ type: 'weather_widget', city: 'Taipei', tempC: 27 })
    expect(part.type).toBe('unsupported')
    expect(part.contentType).toBe('weather_widget')
    expect(part.data).toContain('"type": "weather_widget"')
    expect(part.data).toContain('"city": "Taipei"')
  })

  it('bounds oversized payloads instead of dumping unbounded data', () => {
    const part = unsupportedPartFromBlock({ type: 'blob', payload: 'z'.repeat(MAX_UNSUPPORTED_DATA_CHARS * 2) })
    expect(part.data?.length).toBeLessThanOrEqual(MAX_UNSUPPORTED_DATA_CHARS)
    expect(part.data).toContain('[truncated]')
  })

  it('still yields a readable type label for unserializable blocks', () => {
    const circular: Record<string, unknown> = { type: 'circular' }
    circular.self = circular
    const part = unsupportedPartFromBlock(circular)
    expect(part.contentType).toBe('circular')
    expect(part.data).toBeUndefined()
  })
})

describe('supplementaryPartsFromResult（階段 6.2：live 與 reload 共用）', () => {
  it('extracts images and unknown blocks in order; text blocks stay text', () => {
    const parts = supplementaryPartsFromResult({
      content: [
        { type: 'text', text: 'caption' },
        { type: 'image', mimeType: 'image/png', data: 'aXY=' },
        { type: 'audio', data: 'QUJD' },
      ],
    })
    expect(parts.map((part) => part.type)).toEqual(['image', 'unsupported'])
    expect(parts[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'aXY=' })
    expect(parts[1]).toMatchObject({ type: 'unsupported', contentType: 'audio' })
    expect(parts[1]?.type === 'unsupported' && parts[1].data).toContain('"type": "audio"')
  })

  it('works on bare arrays like imagePartsFromResult', () => {
    const parts = supplementaryPartsFromResult([{ type: 'image', data: 'aXY=', mimeType: 'image/png' }])
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('image')
  })

  it('returns a shared frozen array when there is nothing to keep (no per-event garbage)', () => {
    const empty = supplementaryPartsFromResult({ content: [{ type: 'text', text: 'only text' }] })
    expect(empty).toHaveLength(0)
    expect(Object.isFrozen(empty)).toBe(true)
    expect(supplementaryPartsFromResult('plain')).toBe(empty)
  })

  it('caps the number of kept parts against attachment-flooding results', () => {
    const content = Array.from({ length: 80 }, () => ({ type: 'image', data: 'aXY=', mimeType: 'image/png' }))
    const parts = supplementaryPartsFromResult({ content })
    expect(parts.length).toBeLessThanOrEqual(50)
  })

  it('does not crash on hostile payloads (non-object blocks, deep nesting)', () => {
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let depth = 0; depth < 500; depth += 1) {
      cursor.next = {}
      cursor = cursor.next as Record<string, unknown>
    }
    expect(() => supplementaryPartsFromResult({
      content: [null, 42, 'raw', { type: 'custom_bomb', nested: deep, payload: '<script>alert(1)</script>' }],
    })).not.toThrow()
  })
})
