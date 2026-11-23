// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../src/lib/i18n'
import { SAMPLE_PROJECTS, SAMPLE_SCHEDULES, SAMPLE_SESSIONS } from '../../src/lib/data'
import { ScheduledPage } from '../../src/pages/ScheduledPage'
import type { AutomationScheduleRecord, LocalePreference, PrimeModelDescriptor, PrimeThinkingLevel, ScheduleRunRecord, ScheduleRunStatus } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const NOW = '2026-11-23T12:00:00.000Z'
const runStatuses: ScheduleRunStatus[] = ['queued', 'running', 'succeeded', 'failed', 'skipped', 'interrupted', 'cancelled']
const thinkingLevels: PrimeThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MODELS: PrimeModelDescriptor[] = [{
  key: 'model-a', provider: 'test', id: 'model-a', name: 'Model A', reasoning: true, input: ['text'],
  contextWindow: 200000, maxTokens: 64000, availableThinkingLevels: thinkingLevels, fastModeSupported: true, available: true,
}]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function schedule(overrides: Partial<AutomationScheduleRecord> = {}): AutomationScheduleRecord {
  return {
    ...SAMPLE_SCHEDULES[0],
    id: 'schedule-a',
    revision: 4,
    createdBy: 'agent',
    createdAt: NOW,
    updatedAt: NOW,
    nextRunAt: '2026-11-24T09:00:00.000Z',
    timing: { kind: 'rrule', dtstartLocal: '2026-11-24T09:00:00', timeZone: 'Asia/Taipei', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU' },
    execution: { model: 'model-a', thinking: 'high', speed: 'normal' },
    ...overrides,
  }
}

function run(status: ScheduleRunStatus, index: number): ScheduleRunRecord {
  return {
    id: `run-${status}`,
    taskId: 'schedule-a',
    taskRevision: 4,
    trigger: index % 2 ? 'manual' : 'scheduled',
    scheduledFor: NOW,
    queuedAt: NOW,
    status,
    execution: { model: 'model-a', thinking: 'high', speed: 'normal' },
    error: status === 'failed' ? 'Upstream scheduler failed safely' : undefined,
  }
}

function renderPage(locale: LocalePreference, schedules: AutomationScheduleRecord[], overrides: Partial<Parameters<typeof ScheduledPage>[0]> = {}) {
  const props: Parameters<typeof ScheduledPage>[0] = {
    harness: 'omp',
    schedules,
    projects: SAMPLE_PROJECTS,
    sessions: SAMPLE_SESSIONS,
    models: MODELS,
    lastSelectedModel: 'model-a',
    onCreate: vi.fn(async () => {}),
    onUpdate: vi.fn(async () => {}),
    onPause: vi.fn(async () => {}),
    onResume: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onRunNow: vi.fn(async () => {}),
    onPreview: vi.fn(async (timing) => ({ timing, occurrences: [] })),
    onOpenSession: vi.fn(),
    ...overrides,
  }
  act(() => root.render(<I18nProvider preference={locale}><ScheduledPage {...props} /></I18nProvider>))
  return props
}

function buttonWithText(scope: ParentNode, text: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll('button')].find((item) => item.textContent?.includes(text))
  expect(button, `missing button containing ${text}`).toBeDefined()
  return button!
}

function replaceValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Scheduled page localization', () => {
  it('falls back to English page and status labels for unsupported system languages', () => {
    const languages = Object.getOwnPropertyDescriptor(navigator, 'languages')
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['fr-FR'] })
    try {
      renderPage('system', [schedule({ runs: [] })])
      expect(container.querySelector('h1')?.textContent).toBe('Scheduled')
      expect(container.querySelector('.schedule-state')?.textContent).toBe('active')
      expect(container.querySelector('.schedule-ledger-summary')?.getAttribute('aria-label')).toBe('Schedule summary')
    } finally {
      if (languages) Object.defineProperty(navigator, 'languages', languages)
      else Reflect.deleteProperty(navigator, 'languages')
    }
  })

  it.each([
    {
      locale: 'en',
      all: 'All',
      newSchedule: 'New schedule',
      summary: 'Schedule summary',
      filter: 'Schedule filter',
      statuses: ['active', 'paused', 'completed', 'Needs attention'],
      catalogError: 'Schedule catalog unavailable: Upstream catalog unavailable',
      now: 'Revision 4 · Updated now',
      paused: 'Pause',
      pauseNotice: 'Schedule paused.',
    },
    {
      locale: 'zh-TW',
      all: '全部',
      newSchedule: '新增排程任務',
      summary: '排程任務摘要',
      filter: '排程任務篩選',
      statuses: ['進行中', '已暫停', '已完成', '需要關注'],
      catalogError: '無法取得排程任務目錄:Upstream catalog unavailable',
      now: '修訂版本 4 · 更新於 現在',
      paused: '暫停',
      pauseNotice: '排程任務已暫停。',
    },
    {
      locale: 'zh-CN',
      all: '全部',
      newSchedule: '新建定时任务',
      summary: '定时任务摘要',
      filter: '定时任务筛选',
      statuses: ['进行中', '已暂停', '已完成', '需要注意'],
      catalogError: '无法获取定时任务目录:Upstream catalog unavailable',
      now: '修订版本 4 · 更新于 现在',
      paused: '暂停',
      pauseNotice: '定时任务已暂停。',
    },
  ] as const)('translates list labels, typed states, aria names, and locale time for $locale', async (expected) => {
    const records = (['active', 'paused', 'completed', 'blocked'] as const).map((status, index) => schedule({ id: `schedule-${status}`, title: `Schedule ${status}`, status, runs: [], blockedReason: index === 3 ? 'Upstream blocked reason' : undefined }))
    const props = renderPage(expected.locale, records, { error: 'Upstream catalog unavailable' })
    expect(container.querySelector('h1')?.textContent).toBe(expected.locale === 'en' ? 'Scheduled' : expected.locale === 'zh-TW' ? '排程任務' : '定时任务')
    expect(container.querySelector('.schedule-ledger-summary')?.getAttribute('aria-label')).toBe(expected.summary)
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(expected.filter)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(expected.catalogError)
    expect(buttonWithText(container, expected.newSchedule)).toBeDefined()

    act(() => buttonWithText(container, expected.all).click())
    const rows = [...container.querySelectorAll<HTMLButtonElement>('.schedule-row')]
    expect(rows.map((row) => row.querySelector('.schedule-state')?.textContent)).toEqual(expected.statuses)
    expect(rows[0].getAttribute('aria-label')).toBe(expected.locale === 'en' ? 'Open Schedule active' : expected.locale === 'zh-TW' ? '開啟 Schedule active' : '打开 Schedule active')
    expect(rows[0].textContent).toContain('MO,TU')

    act(() => rows[2].click())
    expect(container.querySelector('.schedule-detail__header p')?.textContent).toBe(expected.now)

    act(() => container.querySelector<HTMLButtonElement>('.schedule-back')!.click())
    act(() => container.querySelector<HTMLButtonElement>('.schedule-row')!.click())
    await act(async () => {
      buttonWithText(container, expected.paused).click()
      await Promise.resolve()
    })
    expect(props.onPause).toHaveBeenCalledExactlyOnceWith('schedule-active')
    expect(container.querySelector('.schedule-action-notice')?.textContent).toBe(expected.pauseNotice)
  })

  it.each([
    { locale: 'en', createdBy: 'agent', thinking: 'high', speed: 'normal', runs: ['queued', 'running', 'succeeded', 'failed', 'skipped', 'interrupted', 'cancelled'], triggers: ['scheduled', 'manual', 'scheduled', 'manual', 'scheduled', 'manual', 'scheduled'] },
    { locale: 'zh-TW', createdBy: '代理程式', thinking: '高', speed: '標準', runs: ['已排入佇列', '執行中', '成功', '失敗', '已略過', '已中斷', '已取消'], triggers: ['排程', '手動', '排程', '手動', '排程', '手動', '排程'] },
    { locale: 'zh-CN', createdBy: '智能体', thinking: '高', speed: '标准', runs: ['已加入队列', '运行中', '成功', '失败', '已跳过', '已中断', '已取消'], triggers: ['定时', '手动', '定时', '手动', '定时', '手动', '定时'] },
  ] as const)('localizes run, execution, and creator codes for $locale without altering raw diagnostics', ({ locale, ...expected }) => {
    const record = schedule({ runs: runStatuses.map(run) })
    renderPage(locale, [record], { selectedScheduleId: record.id })
    const values = [...container.querySelectorAll('.schedule-detail__card dd')].map((item) => item.textContent)
    expect(values).toContain(expected.createdBy)
    expect(values).toContain(expected.thinking)
    expect(values).toContain(expected.speed)
    const history = [...container.querySelectorAll('.schedule-run')]
    expect(history.map((item) => item.querySelector('strong')?.textContent)).toEqual(expected.runs)
    expect(history.map((item) => item.querySelector('.schedule-run__main > div > span')?.textContent)).toEqual(expected.triggers)
    expect(container.textContent).toContain('Upstream scheduler failed safely')
  })

  it.each([
    { locale: 'en', empty: 'No scheduled work', create: 'New schedule', title: 'Create schedule', preview: 'Upcoming schedule preview', frequency: 'Recurrence frequency', error: 'Give this schedule a title.', reasoning: ['Auto', 'Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'] },
    { locale: 'zh-TW', empty: '沒有排程任務', create: '新增排程任務', title: '建立排程任務', preview: '即將到來的排程預覽', frequency: '重複頻率', error: '請為這個排程任務加上標題。', reasoning: ['自動', '關閉', '最低', '低', '標準', '高', '極高', '最高'] },
    { locale: 'zh-CN', empty: '没有定时任务', create: '新建定时任务', title: '创建定时任务', preview: '即将到来的定时任务预览', frequency: '重复频率', error: '请为这个定时任务填写标题。', reasoning: ['自动', '关闭', '最低', '低', '标准', '高', '超高', '最高'] },
  ] as const)('translates empty states, editor errors, and reasoning labels for $locale', async (expected) => {
    const props = renderPage(expected.locale, [])
    act(() => container.querySelector<HTMLButtonElement>('[role="group"] button:last-child')!.click())
    expect(container.querySelector('.empty-state h2')?.textContent).toBe(expected.empty)
    act(() => buttonWithText(container, expected.create).click())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.querySelector('h2')?.textContent).toBe(expected.title)
    expect(dialog.querySelector('.schedule-preview')?.getAttribute('aria-label')).toBe(expected.preview)
    expect(dialog.querySelector('.schedule-frequency')?.getAttribute('aria-label')).toBe(expected.frequency)
    await act(async () => {
      dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(expected.error)
    expect(props.onCreate).not.toHaveBeenCalled()
    const reasoning = dialog.querySelectorAll('.schedule-execution-grid select')[1]
    expect([...reasoning.querySelectorAll('option')].map((option) => ({ value: option.value, label: option.textContent }))).toEqual(['auto', ...thinkingLevels].map((value, index) => ({ value, label: expected.reasoning[index] })))
    act(() => {
      replaceValue(dialog.querySelector<HTMLInputElement>('.schedule-editor__copy input')!, 'Localized schedule')
      replaceValue(dialog.querySelector('textarea')!, 'Run the original prompt')
    })
    await act(async () => {
      dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(props.onCreate).toHaveBeenCalledOnce()
    expect(vi.mocked(props.onCreate).mock.calls[0][0]).toMatchObject({
      title: 'Localized schedule',
      prompt: 'Run the original prompt',
      target: { kind: 'project', projectId: SAMPLE_PROJECTS[0].id },
      execution: { model: 'model-a', thinking: 'auto', speed: 'normal' },
    })
    expect(vi.mocked(props.onCreate).mock.calls[0][0].timing).toMatchObject({ kind: 'rrule', rrule: 'FREQ=DAILY;INTERVAL=1' })
  })
})
