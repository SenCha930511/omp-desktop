import { describe, expect, it } from 'vitest'
import {
  assessMcpUrl,
  assertNoMcpAuthenticationCommand,
  capabilityReloadPrompt,
  classifyMcpUrlHost,
  collectMcpSecretExpansionFields,
  detectMcpSecretExpansion,
  MCP_RELOAD_PROMPT,
  NETWORK_MCP_AUTH_UNAVAILABLE,
  PLUGINS_RELOAD_PROMPT,
} from '../../src/lib/mcp-policy'

describe('MCP network URL policy', () => {
  it('accepts https for any host and marks it secure', () => {
    expect(assessMcpUrl('https://mcp.example/mcp')).toEqual({ ok: true, secure: true, hostClass: 'public', insecurePrivateHttp: false })
    expect(assessMcpUrl('https://192.168.1.10:8443/mcp')).toMatchObject({ ok: true, secure: true, hostClass: 'private' })
    expect(assessMcpUrl('https://localhost:3000/mcp')).toMatchObject({ ok: true, hostClass: 'loopback' })
  })

  it('requires https for public endpoints and refuses other schemes', () => {
    expect(assessMcpUrl('http://mcp.example/mcp').ok).toBe(false)
    expect(assessMcpUrl('http://mcp.example/mcp').error).toContain('https')
    expect(assessMcpUrl('ftp://mcp.example/mcp').ok).toBe(false)
    expect(assessMcpUrl('file:///etc/passwd').ok).toBe(false)
    expect(assessMcpUrl('not a url').ok).toBe(false)
  })

  it('rejects credentials embedded in the URL', () => {
    const result = assessMcpUrl('https://user:secret@mcp.example/mcp')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('credentials')
  })

  it('allows plain http on loopback/private/link-local only with the explicit acknowledgement', () => {
    const privateUrls = [
      'http://127.0.0.1:8080/mcp',
      'http://localhost:8080/mcp',
      'http://[::1]:8080/mcp',
      'http://10.0.0.5/mcp',
      'http://172.16.3.4/mcp',
      'http://192.168.0.20/mcp',
      'http://169.254.1.1/mcp',
      'http://printer.local/mcp',
      'http://nas.internal/mcp',
      'http://[fd00::1]/mcp',
    ]
    for (const url of privateUrls) {
      const refused = assessMcpUrl(url)
      expect(refused.ok).toBe(false)
      expect(refused.insecurePrivateHttp).toBe(true)
      expect(assessMcpUrl(url, { allowInsecureHttp: true })).toMatchObject({ ok: true, secure: false, insecurePrivateHttp: true })
    }
  })

  it('classifies hosts for warning display without pretending to be an SSRF firewall', () => {
    expect(classifyMcpUrlHost('localhost')).toBe('loopback')
    expect(classifyMcpUrlHost('tools.localhost')).toBe('loopback')
    expect(classifyMcpUrlHost('127.4.5.6')).toBe('loopback')
    expect(classifyMcpUrlHost('10.1.2.3')).toBe('private')
    expect(classifyMcpUrlHost('172.31.255.255')).toBe('private')
    expect(classifyMcpUrlHost('172.33.0.1')).toBe('public')
    expect(classifyMcpUrlHost('169.254.10.10')).toBe('link-local')
    expect(classifyMcpUrlHost('fd12::5')).toBe('private')
    expect(classifyMcpUrlHost('fe80::9')).toBe('link-local')
    expect(classifyMcpUrlHost('mcp.example')).toBe('public')
  })
})

describe('MCP secret expansion detection (labels only, never expands)', () => {
  it('detects shell commands and environment references', () => {
    expect(detectMcpSecretExpansion('!gh auth token')).toBe('command')
    expect(detectMcpSecretExpansion('Bearer ${MCP_TOKEN}')).toBe('environment')
    expect(detectMcpSecretExpansion('plain-value')).toBeUndefined()
    expect(detectMcpSecretExpansion('$NOT_BRACED')).toBeUndefined()
    expect(detectMcpSecretExpansion('')).toBeUndefined()
  })

  it('collects bounded field names carrying expansion forms', () => {
    const fields = collectMcpSecretExpansionFields({
      url: 'https://mcp.example/${TOKEN}',
      headers: { Authorization: '!op read secret', 'X-Plain': 'ok' },
      command: 'mcp-server',
      args: ['--key', '${API_KEY}'],
    })
    expect(fields).toContain('url')
    expect(fields).toContain('headers.Authorization')
    expect(fields).toContain('args[1]')
    expect(fields).not.toContain('command')
    expect(fields).not.toContain('headers.X-Plain')
  })
})

describe('capability reload forwarding', () => {
  it('forwards the exact upstream text prompts', () => {
    expect(capabilityReloadPrompt('mcp')).toBe('/mcp reload')
    expect(capabilityReloadPrompt('plugins')).toBe('/reload-plugins')
    expect(MCP_RELOAD_PROMPT).toBe('/mcp reload')
    expect(PLUGINS_RELOAD_PROMPT).toBe('/reload-plugins')
  })

  it('reload prompts are not treated as authentication commands', () => {
    expect(() => assertNoMcpAuthenticationCommand(capabilityReloadPrompt('mcp'))).not.toThrow()
    expect(() => assertNoMcpAuthenticationCommand(capabilityReloadPrompt('plugins'))).not.toThrow()
    expect(() => assertNoMcpAuthenticationCommand('/mcp reauth docs')).toThrow(NETWORK_MCP_AUTH_UNAVAILABLE)
  })
})
