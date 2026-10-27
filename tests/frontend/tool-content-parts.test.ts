import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { imageSource } from '../../src/components/transcript/attachment-part'
import { WorkTimeline } from '../../src/components/transcript/timeline'
import { replayPrimeEvents, resetTranscriptIdsForTests } from '../../src/lib/events'
import type { MessagePart } from '../../src/types/api'

/**
 * 階段 6.2:非文字工具內容安全呈現。
 * （a）live event stream 路徑在此驗證;（b）重開讀 .jsonl 與（c）fork 後
 * 新 leaf 兩條路徑共用 electron/main/sessions/transcript.ts 的 reader,
 * 由 tests/backend/transcript.test.ts 斷言,三態的 part 形狀一致。
 */

const PNG = 'aXY='
const TOOL_RESULT = {
  content: [
    { type: 'text', text: 'rendered a chart' },
    { type: 'image', mimeType: 'image/png', data: PNG },
    { type: 'weather_widget', city: 'Taipei', tempC: 27 },
  ],
}

function liveParts(): MessagePart[] {
  resetTranscriptIdsForTests()
  const messages = replayPrimeEvents([], [
    { type: 'agent_start' },
    { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'chart_tool', args: { query: 'weather' } },
    { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'chart_tool', result: TOOL_RESULT },
    { type: 'agent_end' },
  ])
  expect(messages).toHaveLength(1)
  return messages[0]!.parts
}

describe('（a）live event stream:工具結果非文字內容保留原始型別', () => {
  it('keeps toolCall → toolResult → image → unsupported in order with unique partIds', () => {
    const parts = liveParts()
    expect(parts.map((part) => part.type)).toEqual(['toolCall', 'toolResult', 'image', 'unsupported'])
    const [call, result, image, unsupported] = parts
    expect(call).toMatchObject({ type: 'toolCall', name: 'chart_tool' })
    expect(result).toMatchObject({ type: 'toolResult', text: 'rendered a chart', isError: false })
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png', data: PNG })
    expect(unsupported).toMatchObject({ type: 'unsupported', contentType: 'weather_widget' })
    expect(unsupported?.type === 'unsupported' && unsupported.data).toContain('"city": "Taipei"')

    const ids = parts.map((part) => part.partId)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(parts.length)
  })

  it('does not emit supplementary garbage for a text-only result', () => {
    resetTranscriptIdsForTests()
    const messages = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'agent_end' },
    ])
    expect(messages[0]?.parts.map((part) => part.type)).toEqual(['toolCall', 'toolResult'])
  })
})

describe('（a+b）rendering:live 與 reload 相同的 part 形狀渲染出可讀視圖', () => {
  it('renders the tool image as a safe data URL and the unknown block as a data view', () => {
    const html = renderToStaticMarkup(createElement(WorkTimeline, {
      parts: liveParts(),
      showReasoning: true,
      showTools: true,
    }))
    expect(html).toContain(`src="data:image/png;base64,${PNG}"`)
    expect(html).toContain('aria-label="Expand pasted image"')
    expect(html).toContain('[Unsupported attachment: weather_widget]')
    // 「自訂檢視不可用」等級標示明確出現,不是靜默丟棄
    expect(html).toContain('custom view unavailable')
    expect(html).toContain('&quot;city&quot;: &quot;Taipei&quot;')
    expect(html).toContain('attachment-part__data')
  })

  it('renders an unsupported part without data as the label-only fallback', () => {
    const html = renderToStaticMarkup(createElement(WorkTimeline, {
      parts: [{ type: 'unsupported', contentType: 'mystery' }],
      showReasoning: true,
      showTools: true,
    }))
    expect(html).toContain('[Unsupported attachment: mystery]')
    expect(html).not.toContain('attachment-part__data')
  })
})

describe('security:image/data payload 注入面', () => {
  const part = (overrides: Partial<Extract<MessagePart, { type: 'image' }>>) =>
    ({ type: 'image', ...overrides }) as Extract<MessagePart, { type: 'image' }>

  it('only ever builds data: URLs from whitelisted image mime types', () => {
    expect(imageSource(part({ mimeType: 'image/png', data: PNG }))).toBe(`data:image/png;base64,${PNG}`)
    expect(imageSource(part({ mimeType: 'image/svg+xml', data: 'PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+' }))).toBeUndefined()
    expect(imageSource(part({ mimeType: 'text/html', data: 'PHNjcmlwdD4=' }))).toBeUndefined()
    expect(imageSource(part({ mimeType: 'image/png', data: PNG, dataTruncated: true }))).toBeUndefined()
  })

  it('rejects non-base64 payloads so arbitrary URLs/scripts cannot become img src', () => {
    expect(imageSource(part({ mimeType: 'image/png', data: 'https://evil.example/x.png' }))).toBeUndefined()
    expect(imageSource(part({ mimeType: 'image/png', data: `javascript:alert(1)//${PNG}` }))).toBeUndefined()
    expect(imageSource(part({ mimeType: 'image/png', data: undefined }))).toBeUndefined()
  })

  it('renders hostile unsupported-block data as escaped text, never as markup', () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
    const html = renderToStaticMarkup(createElement(WorkTimeline, {
      parts: [{ type: 'unsupported', contentType: 'evil_widget', data: JSON.stringify({ type: 'evil_widget', html: hostile }, null, 2) }],
      showReasoning: true,
      showTools: true,
    }))
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('onerror="alert(1)"')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('evil_widget')
  })

  it('bounds rendered data view size so oversized payloads stay truncated', () => {
    const html = renderToStaticMarkup(createElement(WorkTimeline, {
      parts: [{ type: 'unsupported', contentType: 'blob', data: 'x'.repeat(12_000) }],
      showReasoning: true,
      showTools: true,
    }))
    expect(html.length).toBeLessThan(8_000)
    expect(html).toContain('…')
  })
})
