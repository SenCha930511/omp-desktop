import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_INJECTIONS, SHIPPED_EXTENSION_FILENAMES, type ExtensionInjection } from '../../electron/main/extension-manifest'
import type { OmpExtensionApi } from '../../assets/extensions/omp-work-browser'

type Registration = { kind: 'tool' | 'command' | 'event'; name: string }

interface Fixture {
  api: object
  registrations: Registration[]
}

function ompHost(withTypebox = true): Fixture {
  const registrations: Registration[] = []
  const target: OmpExtensionApi = withTypebox
    ? {
        typebox: {
          Type: {
            Object: (...args: unknown[]) => ({ kind: 'object', args }),
            String: (...args: unknown[]) => ({ kind: 'string', args }),
            Number: (...args: unknown[]) => ({ kind: 'number', args }),
            Boolean: (...args: unknown[]) => ({ kind: 'boolean', args }),
            Array: (...args: unknown[]) => ({ kind: 'array', args }),
            Enum: (...args: unknown[]) => ({ kind: 'enum', args }),
            Optional: (...args: unknown[]) => ({ kind: 'optional', args }),
          },
        },
        registerTool: (tool) => { registrations.push({ kind: 'tool', name: tool.name }) },
      }
    : { registerTool: (tool) => { registrations.push({ kind: 'tool', name: tool.name }) } }
  const api = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || property === 'then' || property === 'constructor') return Reflect.get(object, property, receiver)
      // Model a host that does not inject the optional typebox shim: probing it yields undefined, not a throw.
      if (property === 'typebox' && !withTypebox) return undefined
      if (!(property in object)) throw new Error(`OMP fixture does not inject ${String(property)}`)
      return Reflect.get(object, property, receiver)
    },
  })
  return { api, registrations }
}

const expectedRegistrations: Record<string, Registration[]> = {
  'omp-work-browser.ts': [
    ...['terminal_read', 'browser_tabs', 'browser_navigate', 'browser_screenshot', 'browser_read_page', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_evaluate'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'omp-work-ask-user.ts': [{ kind: 'tool', name: 'ask_user' }],
  'omp-work-collaboration.ts': [
    ...['gooeypi_session_list', 'gooeypi_session_models', 'gooeypi_session_create', 'gooeypi_session_read', 'gooeypi_session_send', 'gooeypi_session_wait'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'omp-work-schedules.ts': [
    ...['scheduled_tasks_list', 'scheduled_task_create_once', 'scheduled_task_create_recurring', 'scheduled_task_update', 'scheduled_task_manage'].map((name) => ({ kind: 'tool' as const, name })),
  ],
}

const brokerVariables: Partial<Record<ExtensionInjection['capability'], readonly [string, string]>> = {
  browser: ['OMP_DESKTOP_BROWSER_URL', 'OMP_DESKTOP_BROWSER_TOKEN'],
  schedule: ['OMP_DESKTOP_SCHEDULE_URL', 'OMP_DESKTOP_SCHEDULE_TOKEN'],
  collaboration: ['GOOEYPI_COLLABORATION_URL', 'GOOEYPI_COLLABORATION_TOKEN'],
}

const LEGACY_UNPREFIXED_TOOLS = [
  'ask_user', 'terminal_read', 'browser_tabs', 'browser_navigate', 'browser_screenshot', 'browser_read_page',
  'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_evaluate',
  'scheduled_tasks_list', 'scheduled_task_create_once', 'scheduled_task_create_recurring',
  'scheduled_task_update', 'scheduled_task_manage',
]

async function loadExtension(injection: ExtensionInjection, configured: boolean) {
  vi.resetModules()
  vi.unstubAllEnvs()
  const variables = brokerVariables[injection.capability]
  if (configured && variables) {
    vi.stubEnv(variables[0], 'http://127.0.0.1:1/')
    vi.stubEnv(variables[1], 'inert-test-token')
  }
  // The extension filename is manifest data, so the specifier is genuinely runtime-selected.
  const url = pathToFileURL(join(process.cwd(), 'assets', 'extensions', injection.filename)).href
  return (await import(url)).default as (api: object) => void | Promise<void>
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('shipped extension contracts', () => {
  it('initializes every manifest injection against its genuine host surface', async () => {
    for (const filename of SHIPPED_EXTENSION_FILENAMES) {
      expect(expectedRegistrations[filename], `Missing registration contract for ${filename}`).toBeDefined()
    }
    for (const [harness, injections] of Object.entries(EXTENSION_INJECTIONS)) {
      expect(harness).toBe('omp')
      for (const injection of injections) {
        for (const configured of [false, true]) {
          const fixture = ompHost()
          const factory = await loadExtension(injection, configured)
          await factory(fixture.api)
          const expected = expectedRegistrations[injection.filename]
          expect(fixture.registrations, `${harness}/${injection.filename} configured=${configured}`).toEqual(
            configured || !brokerVariables[injection.capability] ? expected : [],
          )
        }
      }
    }
  })

  it('keeps the optional typebox shim safe to probe on hosts that do not inject it', () => {
    const fixture = ompHost(false)
    expect((fixture.api as OmpExtensionApi).typebox).toBeUndefined()
    expect(fixture.registrations).toEqual([])
  })

  it('keeps tool registrations namespaced', () => {
    // The allow-list only shrinks as legacy tools are renamed. See #192.
    for (const registrations of Object.values(expectedRegistrations)) {
      for (const registration of registrations) {
        if (registration.kind !== 'tool') continue
        expect(registration.name.startsWith('gooeypi_') || LEGACY_UNPREFIXED_TOOLS.includes(registration.name)).toBe(true)
      }
    }
  })

  it('rejects properties outside each host fixture from the proxy trap', () => {
    const fixture = ompHost()
    expect(() => Reflect.get(fixture.api, 'unsupportedCapability')).toThrow('OMP fixture does not inject unsupportedCapability')
  })

  it('derives the shipped inventory from the actual extension directory', () => {
    const actual = readdirSync(join(process.cwd(), 'assets', 'extensions'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort()
    expect(SHIPPED_EXTENSION_FILENAMES).toEqual(actual)
  })
})
