// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { CommandOutputPanel } from '../../src/components/CommandOutputPanel'
import { useCommandOutput } from '../../src/hooks/useCommandOutput'
import { I18nProvider } from '../../src/lib/i18n'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('shows localized, dismissible command results and isolates workspaces', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  let output: ReturnType<typeof useCommandOutput>
  function Harness({ owner }: { owner: number }) {
    output = useCommandOutput(owner)
    return <I18nProvider preference="zh-TW"><CommandOutputPanel text={output.text} onClose={output.dismiss} /></I18nProvider>
  }
  try {
    act(() => root.render(<Harness owner={1} />))
    act(() => { output.append('first line'); output.append('second line') })
    expect(host.querySelector('section')?.getAttribute('aria-label')).toBe('指令結果')
    expect(host.querySelector('pre')?.textContent).toBe('first line\nsecond line')
    act(() => host.querySelector<HTMLButtonElement>('button')!.click())
    expect(host.querySelector('section')).toBeNull()
    act(() => output.append('another result'))
    act(() => root.render(<Harness owner={2} />))
    expect(host.querySelector('section')).toBeNull()
    act(() => output.append('new workspace'))
    expect(host.textContent).not.toContain('another result')
  } finally { act(() => root.unmount()) }
})
