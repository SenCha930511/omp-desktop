// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { CommandOutputPanel } from '../../src/components/CommandOutputPanel'
import { type CommandOutputView, useCommandOutput } from '../../src/hooks/useCommandOutput'
import { I18nProvider } from '../../src/lib/i18n'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('retains five results and routes new output to the active command while browsing history', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  let output: CommandOutputView
  function Harness() {
    output = useCommandOutput(1)
    return <CommandOutputPanel text={output.text} command={output.command} status={output.status} history={output.history} selectedId={output.selectedId} onSelect={output.select} onClose={output.dismiss} />
  }
  try {
    act(() => root.render(<Harness />))
    for (let index = 0; index < 6; index++) {
      act(() => output.begin(`/command-${index}`))
      act(() => { output.append(`Result ${index}`); output.finish() })
    }
    expect(output!.history.map((entry) => entry.command)).toEqual(['/command-5', '/command-4', '/command-3', '/command-2', '/command-1'])
    act(() => output.select(output.history[1].id))
    act(() => output.append('Late output'))
    expect(host.querySelector('pre')?.textContent).toBe('Result 4')
    expect(output!.history[0].text).toBe('Result 5\nLate output')
    act(() => output.dismiss())
    act(() => output.append('Output received while closed'))
    expect(host.querySelector('section')).toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('.command-history-trigger__reopen')!.click())
    expect(host.querySelector('pre')?.textContent).toContain('Late output')
    expect(host.querySelector('pre')?.textContent).toContain('Output received while closed')
  } finally { act(() => root.unmount()) }
})

it('lets the history chip be cleared entirely so nothing lingers', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  let output: CommandOutputView
  function Harness() {
    output = useCommandOutput(1)
    return <CommandOutputPanel text={output.text} command={output.command} status={output.status} history={output.history} selectedId={output.selectedId} onSelect={output.select} onClose={output.dismiss} onClear={output.clear} />
  }
  try {
    act(() => root.render(<Harness />))
    act(() => { output.begin('/context'); output.append('Opps: whoa'); output.finish() })
    act(() => output.dismiss())
    const clearButton = host.querySelector<HTMLButtonElement>('.command-history-trigger__clear')
    expect(clearButton).not.toBeNull()
    expect(clearButton?.getAttribute('aria-label')).toBe('Clear recent command results')
    act(() => clearButton!.click())
    expect(host.querySelector('.command-history-trigger')).toBeNull()
    expect(output!.history).toHaveLength(0)
  } finally { act(() => root.unmount()) }
})

it('shows localized, dismissible command results and isolates workspaces', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  let output: CommandOutputView
  function Harness({ owner }: { owner: number }) {
    output = useCommandOutput(owner)
    return <I18nProvider preference="zh-TW"><CommandOutputPanel text={output.text} command={output.command} status={output.status} onClose={output.dismiss} /></I18nProvider>
  }
  try {
    act(() => root.render(<Harness owner={1} />))
    act(() => { output.append('first line'); output.append('second line') })
    expect(host.querySelector('section')?.getAttribute('aria-label')).toBe('指令結果')
    expect(host.querySelector('pre')?.textContent).toBe('first line\nsecond line')
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="關閉指令結果"]')!.click())
    expect(host.querySelector('section')).toBeNull()
    act(() => output.append('another result'))
    act(() => root.render(<Harness owner={2} />))
    expect(host.querySelector('section')).toBeNull()
    act(() => output.append('new workspace'))
    expect(host.textContent).not.toContain('another result')
    act(() => output.begin('/context'))
    expect(host.textContent).toContain('正在執行指令')
    act(() => output.append('\u001b[32mContext\u001b[0m'))
    act(() => output.finish())
    expect(host.querySelector('pre')?.textContent).toBe('Context')
    act(() => host.querySelector<HTMLButtonElement>('[aria-expanded]')!.click())
    expect(host.querySelector('pre')).toBeNull()
    act(() => output.begin('/modelpreset list'))
    act(() => output.finish('Fixture failed'))
    expect(host.querySelector('.is-failed')).not.toBeNull()
    expect(host.querySelector('pre')?.textContent).toBe('Fixture failed')
    act(() => output.begin('/extension-command'))
    act(() => output.append('Extension rejected the command', true))
    act(() => output.finish())
    expect(host.querySelector('.command-output__status')?.textContent).toBe('失敗')
    act(() => output.begin('/skill:review'))
    act(() => output.finish(undefined, true))
    expect(host.querySelector('section')).toBeNull()
  } finally { act(() => root.unmount()) }
})
