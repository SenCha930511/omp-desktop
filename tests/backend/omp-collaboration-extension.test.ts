import { afterEach, describe, expect, it, vi } from 'vitest'

interface RegisteredTool { name: string }
interface ExtensionApi { registerTool(tool: RegisteredTool): void }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loadExtension(url?: string, token?: string): Promise<(api: ExtensionApi) => void | Promise<void>> {
  vi.resetModules()
  vi.stubEnv('GOOEYPI_COLLABORATION_URL', url ?? (undefined as unknown as string))
  vi.stubEnv('GOOEYPI_COLLABORATION_TOKEN', token ?? (undefined as unknown as string))
  // The extension takes no arguments; the cast models OMP invoking it with the host API.
  return (await import('../../assets/extensions/omp-work-collaboration')).default as unknown as (api: ExtensionApi) => void | Promise<void>
}

function fakePi() {
  const tools: RegisteredTool[] = []
  return { tools, pi: { registerTool: (tool: RegisteredTool) => { tools.push(tool) } } }
}

describe('omp-work-collaboration extension', () => {
  it('registers no tools now that session collaboration runs as host tools', async () => {
    for (const [url, token] of [
      [undefined, undefined],
      ['http://127.0.0.1:9/broker', 'inert-test-token'],
    ] as const) {
      const factory = await loadExtension(url, token)
      const { tools, pi } = fakePi()
      await factory(pi)
      expect(tools).toEqual([])
    }
  })
})
