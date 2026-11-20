import { afterEach, describe, expect, it } from 'vitest'
import { requireCapability, requiredCapabilities } from './client'
import type { AdapterInfo } from './protocol'

const info: AdapterInfo = {
  protocolVersion: 1,
  implementation: 'test-adapter',
  platform: 'test',
  capabilities: ['state'],
}

const saved = {
  partial: process.env.OMP_CONFORMANCE_PARTIAL,
  required: process.env.OMP_CONFORMANCE_REQUIRED_CAPABILITIES,
}

afterEach(() => {
  if (saved.partial === undefined) delete process.env.OMP_CONFORMANCE_PARTIAL
  else process.env.OMP_CONFORMANCE_PARTIAL = saved.partial
  if (saved.required === undefined) delete process.env.OMP_CONFORMANCE_REQUIRED_CAPABILITIES
  else process.env.OMP_CONFORMANCE_REQUIRED_CAPABILITIES = saved.required
})

describe('conformance: required capability gate', () => {
  it('lets partial mode skip a capability outside the required set', () => {
    process.env.OMP_CONFORMANCE_PARTIAL = '1'
    delete process.env.OMP_CONFORMANCE_REQUIRED_CAPABILITIES
    expect(requireCapability(info, 'terminal')).toBe(false)
  })

  it('never skips a capability named in the required set, even in partial mode', () => {
    process.env.OMP_CONFORMANCE_PARTIAL = '1'
    process.env.OMP_CONFORMANCE_REQUIRED_CAPABILITIES = 'state,terminal'
    expect(requiredCapabilities()).toEqual(['state', 'terminal'])
    expect(() => requireCapability(info, 'terminal')).toThrow(/missing required conformance capability/)
  })

  it('reports a present required capability as satisfied', () => {
    process.env.OMP_CONFORMANCE_PARTIAL = '1'
    process.env.OMP_CONFORMANCE_REQUIRED_CAPABILITIES = 'state'
    expect(requireCapability(info, 'state')).toBe(true)
  })
})
