import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OMP_TITLE_SLOT_BYTES, readOmpTranscript } from '../../electron/main/sessions/omp'
import { replayPrimeEvents } from '../../src/lib/events/reduce'
import type { TranscriptMessage } from '../../src/types/api'

/**
 * Golden: 同一組邏輯內容分別餵給 live reducer（事件流）與持久化 transcript
 * reader（session 檔案），兩側必須產生結構等價的 MessagePart。
 * 只忽略沒有對應關係的欄位（partId、toolCall id、streaming、時間戳）。
 */

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

function titleSlot(title = ''): string {
  const unpadded = JSON.stringify({ type: 'title', v: 1, title, updatedAt: '2026-08-08T02:12:49.414Z', pad: '' })
  return JSON.stringify({ type: 'title', v: 1, title, updatedAt: '2026-08-08T02:12:49.414Z', pad: ' '.repeat(OMP_TITLE_SLOT_BYTES - 1 - Buffer.byteLength(unpadded, 'utf8')) })
}

function ompSessionFile(entries: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'omp-desktop-parity-'))
  dirs.push(dir)
  const file = join(dir, '2026-08-08T02-12-49-414Z_019fdf24-f686-7000-86fd-e1eaf84626c6.jsonl')
  writeFileSync(file, [
    titleSlot(),
    JSON.stringify({ type: 'session', version: 3, id: '019fdf24-f686-7000-86fd-e1eaf84626c6', timestamp: '2026-08-08T02:12:49.414Z', cwd: '/tmp' }),
    ...entries,
    '',
  ].join('\n'))
  return file
}

/** 使用者、助理、工具三種 message 記錄的精簡建構器。 */
function messageEntry(id: string, parentId: string | null, message: Record<string, unknown>, at: string): string {
  return JSON.stringify({ type: 'message', id, parentId, timestamp: at, message })
}

function customEntry(id: string, parentId: string, record: Record<string, unknown>, at: string): string {
  return JSON.stringify({ type: 'custom_message', id, parentId, timestamp: at, display: true, ...record })
}

/** 抹除兩側沒有對應關係的欄位，只比較角色、署名與 part 結構。 */
function normalize(messages: TranscriptMessage[]): unknown {
  return messages.map((message) => ({
    role: message.role,
    agentName: message.agentName,
    parts: message.parts.map((part) =>
      JSON.parse(JSON.stringify(part, (key: string, value: unknown) => (key === 'partId' || key === 'id' || key === 'streaming' ? undefined : value))) as unknown),
  }))
}

describe('live reducer vs persisted transcript parity', () => {
  it('produces structurally equivalent parts for the same logical content', async () => {
    // 持久化路徑：八筆記錄涵蓋 tool 結果圖片（GAP 2）、其他 display 的
    // customType（GAP 1e）、goal_context（GAP 1a）、陣列內容的 agent_message
    // （GAP 4）、純物件工具結果（GAP 5），以及無活動回合時的獨立列。
    const file = ompSessionFile([
      messageEntry('u1', null, { role: 'user', content: 'Work the task.' }, '2026-08-08T02:13:00.000Z'),
      messageEntry('a1', 'u1', {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Plan the work' },
          { type: 'text', text: 'First reply' },
          { type: 'toolCall', id: 'call-1', name: 'Bash', arguments: { command: 'cat chart.png' } },
        ],
      }, '2026-08-08T02:13:01.000Z'),
      messageEntry('t1', 'a1', {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'Bash',
        content: [
          { type: 'text', text: 'image follows' },
          { type: 'image', mimeType: 'image/png', data: 'aW1nZGF0YQ==' },
        ],
      }, '2026-08-08T02:13:02.000Z'),
      customEntry('cm1', 't1', {
        customType: 'agent_message',
        content: [
          { type: 'text', text: 'Line one' },
          { type: 'image', mimeType: 'image/png', data: 'aXY=' },
          { type: 'text', text: 'Line two' },
        ],
      }, '2026-08-08T02:13:03.000Z'),
      customEntry('cm2', 'cm1', { customType: 'ipython_state_restored', content: 'Kernel state restored.' }, '2026-08-08T02:13:04.000Z'),
      customEntry('cm3', 'cm2', {
        customType: 'goal_context',
        content: '<goal_context>Internal control envelope.</goal_context>',
        details: { objective: 'Finish the milestone.' },
      }, '2026-08-08T02:13:05.000Z'),
      customEntry('cm4', 'cm3', { customType: 'weather_widget', content: 'Sunny, 26°C' }, '2026-08-08T02:13:06.000Z'),
      customEntry('cm5', 'cm4', {
        customType: 'agent_message',
        details: { message: 'Final review passed.', from: { sessionName: 'reviewer' } },
      }, '2026-08-08T02:13:07.000Z'),
      messageEntry('a2', 'cm5', {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-2', name: 'read_data', arguments: { path: 'data.json' } }],
      }, '2026-08-08T02:13:08.000Z'),
      messageEntry('t2', 'a2', {
        role: 'toolResult',
        toolCallId: 'call-2',
        toolName: 'read_data',
        content: { ok: true, count: 2 },
      }, '2026-08-08T02:13:09.000Z'),
    ])

    // live 路徑：從同一則使用者訊息出發，事件與上述記錄一一對應。
    const live = replayPrimeEvents(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Work the task.' }] }],
      [
        { type: 'agent_start' },
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Plan the work' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'First reply' } },
        { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 'call-1', name: 'Bash', arguments: { command: 'cat chart.png' } } } },
        {
          type: 'tool_execution_end',
          toolName: 'Bash',
          toolCallId: 'call-1',
          result: {
            content: [
              { type: 'text', text: 'image follows' },
              { type: 'image', mimeType: 'image/png', data: 'aW1nZGF0YQ==' },
            ],
          },
        },
        {
          type: 'custom_message',
          customType: 'agent_message',
          display: true,
          content: [
            { type: 'text', text: 'Line one' },
            { type: 'image', mimeType: 'image/png', data: 'aXY=' },
            { type: 'text', text: 'Line two' },
          ],
        },
        { type: 'custom_message', customType: 'ipython_state_restored', display: true, content: 'Kernel state restored.' },
        {
          type: 'custom_message',
          customType: 'goal_context',
          display: true,
          content: '<goal_context>Internal control envelope.</goal_context>',
          details: { objective: 'Finish the milestone.' },
        },
        { type: 'custom_message', customType: 'weather_widget', display: true, content: 'Sunny, 26°C' },
        {
          type: 'custom_message',
          customType: 'agent_message',
          display: true,
          details: { message: 'Final review passed.', from: { sessionName: 'reviewer' } },
        },
        { type: 'agent_start' },
        { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 'call-2', name: 'read_data', arguments: { path: 'data.json' } } } },
        { type: 'tool_execution_end', toolName: 'read_data', toolCallId: 'call-2', result: { ok: true, count: 2 } },
        { type: 'agent_end' },
      ],
    )

    const persisted = await readOmpTranscript(file, false)
    expect(normalize(live)).toEqual(normalize(persisted))
  })

  it('keeps unknown content blocks as readable placeholders instead of dropping them (GAP 3)', async () => {
    const file = ompSessionFile([
      messageEntry('u1', null, {
        role: 'user',
        content: [
          { type: 'text', text: 'See the attached file.' },
          { type: 'file', name: 'data.csv' },
        ],
      }, '2026-08-08T02:13:00.000Z'),
    ])

    const [row] = await readOmpTranscript(file, false)
    expect(row?.parts).toEqual([
      { type: 'text', text: 'See the attached file.' },
      // 6.2: unsupported parts carry a bounded JSON dump of the original block
      // so the renderer can show a readable data view instead of a bare badge.
      { type: 'unsupported', contentType: 'file', data: JSON.stringify({ type: 'file', name: 'data.csv' }, null, 2) },
    ])
  })
})
