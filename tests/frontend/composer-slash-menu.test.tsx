// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'
import { groupModelsByProvider } from '../../src/hooks/useProviderCatalog'
import type { PrimeModelDescriptor, PrimeProviderDescriptor, SkillRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const models: PrimeModelDescriptor[] = [{
  key: 'provider/vision', provider: 'provider', id: 'vision', name: 'Vision', reasoning: true,
  input: ['text'], contextWindow: 100_000, maxTokens: 8_000,
  availableThinkingLevels: ['medium'], fastModeSupported: false, available: true,
}]
const providers: PrimeProviderDescriptor[] = [{
  id: 'provider', name: 'Provider', authMethod: 'api_key', configured: true,
  modelCount: 1, availableModelCount: 1,
}]
const modelsByProvider = groupModelsByProvider(models)

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('Composer slash menu skill icon alignment', () => {
  it('renders skill icons with fixed non-shrinking sizing aligned with builtin commands', () => {
    const skills: SkillRecord[] = [
      {
        id: 'architect',
        name: 'architect',
        description: 'Sketch types, signatures, and module structure before coding or refactoring large multi-file features.',
        kind: 'skill',
        location: 'user',
        enabled: true,
      },
      {
        id: 'bro',
        name: 'bro',
        description: 'Short note',
        kind: 'skill',
        location: 'user',
        enabled: true,
      },
    ]

    act(() => {
      root.render(
        <Composer
          busy={false}
          model="provider/vision"
          effort="medium"
          modelsByProvider={modelsByProvider}
          providers={providers}
          reasoningLevels={['medium']}
          fast={false}
          fastSupported={false}
          fastAvailable={false}
          imageInputSupported={false}
          messageEnterAction="queue"
          skills={skills}
          availableCommands={[
            { name: 'btw', description: 'Open side questions', source: 'builtin' },
            { name: 'skill:architect', description: skills[0].description, source: 'skill' },
            { name: 'skill:bro', description: skills[1].description, source: 'skill' },
          ]}
          onModelChange={vi.fn()}
          onEffortChange={vi.fn()}
          onFastChange={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />,
      )
    })

    const textarea = container.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '/')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const options = [...container.querySelectorAll<HTMLButtonElement>('.composer-menu button[role="option"]')]
    expect(options.length).toBeGreaterThanOrEqual(3)

    const icons = options.map((button) => button.querySelector('svg'))
    for (const icon of icons) {
      expect(icon).not.toBeNull()
      expect(icon?.getAttribute('width')).toBe('14')
      expect(icon?.getAttribute('height')).toBe('14')
      expect(icon?.getAttribute('aria-hidden')).toBe('true')
    }

    const css = readFileSync(resolve('src/styles/composer.css'), 'utf8')
    expect(css).toContain('.composer-menu button > svg { flex: 0 0 auto; width: 14px; height: 14px; }')
    expect(css).toContain('.composer-menu button > span { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }')
  })
})
