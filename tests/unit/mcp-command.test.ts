import { describe, expect, it } from 'vitest'
import { parseMcpCommand } from '../../src/hooks/useWorkspaceActions'

describe('OMP MCP slash command routing', () => {
  it('extracts a bounded MCP reauth target', () => {
    expect(parseMcpCommand('/mcp reauth docs')).toEqual({ type: 'authenticate', server: 'docs' })
    expect(parseMcpCommand('/mcp   reauth   team docs')).toEqual({ type: 'authenticate', server: 'team docs' })
  })

  it('blocks unsafe reauth targets instead of forwarding them to the harness', () => {
    expect(parseMcpCommand('/mcp reauth ../docs')).toEqual({ type: 'authenticate' })
    expect(parseMcpCommand('/mcp reauth __proto__')).toEqual({ type: 'authenticate' })
  })

  it('intercepts the remote-auth command while leaving local MCP commands alone', () => {
    expect(parseMcpCommand('/mcp reauth')).toEqual({ type: 'authenticate' })
    expect(parseMcpCommand('/mcp list')).toBeUndefined()
    expect(parseMcpCommand('/mcp')).toBeUndefined()
    expect(parseMcpCommand('/mcp login notion')).toBeUndefined()
  })
})
