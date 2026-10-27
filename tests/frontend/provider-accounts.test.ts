// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  LOGIN_FLOW_TIMEOUT_MS,
  parseLoginProviders,
  parseLoginResult,
  parseLogoutAccounts,
  parseLogoutResult,
} from '../../src/lib/provider-accounts'

describe('provider account wire parsing', () => {
  // 上游 rpc-types.ts(v18.13.1)回覆 data 包裝:
  // get_login_providers → { providers },login → { providerId },
  // get_logout_accounts → { accounts },logout → { remainingSource? }。
  it('accepts the exact upstream get_login_providers shape', () => {
    expect(parseLoginProviders({ providers: [{ id: 'anthropic', name: 'Anthropic', available: true, authenticated: true }] })).toEqual([
      { id: 'anthropic', name: 'Anthropic', available: true, authenticated: true },
    ])
    expect(parseLoginProviders({ providers: [] })).toEqual([])
  })

  it('drops malformed provider rows instead of guessing', () => {
    expect(parseLoginProviders({
      providers: [
        { id: 'anthropic', name: 'Anthropic', available: true, authenticated: false },
        { id: 'broken' },
        { name: 'no-id', available: true, authenticated: true },
        'not-an-object',
      ],
    })).toEqual([{ id: 'anthropic', name: 'Anthropic', available: true, authenticated: false }])
  })

  it('normalizes missing/bogus flags to false (never falsely authenticated)', () => {
    expect(parseLoginProviders({ providers: [{ id: 'a', name: 'A', available: 'yes', authenticated: 1 }] })).toEqual([
      { id: 'a', name: 'A', available: false, authenticated: false },
    ])
  })

  it('accepts the exact upstream LogoutAccount shape, active first order preserved', () => {
    const accounts = [
      { credentialId: 7, provider: 'anthropic', label: 'me@example.com', detail: 'Team plan', type: 'oauth', active: true },
      { credentialId: 3, provider: 'anthropic', label: 'API key', detail: '', type: 'api_key', active: false },
    ]
    expect(parseLogoutAccounts({ accounts })).toEqual(accounts)
  })

  it('rejects whole payload when the documented wrapper is absent', () => {
    expect(parseLoginProviders(undefined)).toBeUndefined()
    expect(parseLoginProviders({ providers: 'nope' })).toBeUndefined()
    expect(parseLogoutAccounts({ accounts: {} })).toBeUndefined()
    expect(parseLoginResult({})).toBeUndefined()
    expect(parseLoginResult({ providerId: 'anthropic' })).toEqual({ providerId: 'anthropic' })
    expect(parseLogoutResult({ remainingSource: 'ANTHROPIC_API_KEY' })).toEqual({ remainingSource: 'ANTHROPIC_API_KEY' })
    expect(parseLogoutResult({})).toEqual({})
    expect(parseLogoutResult(null)).toEqual({})
  })

  it('drops unknown and numeric-tagged logout account rows', () => {
    expect(parseLogoutAccounts({
      accounts: [
        { credentialId: 1, provider: 'anthropic', label: 'a', detail: '', type: 'oauth', active: true },
        { credentialId: 2.5, provider: 'anthropic', label: 'b', detail: '', type: 'oauth', active: false },
        { credentialId: 0, provider: 'anthropic', label: 'c', detail: '', type: 'oauth', active: false },
        { credentialId: 4, provider: 'anthropic', label: 'd', detail: '', type: 'cookie', active: false },
      ],
    })).toEqual([{ credentialId: 1, provider: 'anthropic', label: 'a', detail: '', type: 'oauth', active: true }])
  })
})

describe('credential custody boundary (OMP owns tokens; GUI never retains secrets)', () => {
  // 憑證歸屬斷言:即使上游回覆未來誤增祕密欄位,白名單解析器必須丟棄,
  // GUI 狀態不得吸收任何 token/secret/access/refresh/auth 內容欄位。
  it('parseLoginProviders keeps only the documented non-secret fields', () => {
    const parsed = parseLoginProviders({
      providers: [{
        id: 'anthropic',
        name: 'Anthropic',
        available: true,
        authenticated: true,
        accessToken: 'sk-ant-oat01-leak',
        refreshToken: 'refresh-leak',
        secretKey: 'secret-leak',
        authHeader: 'Authorization: Bearer leak',
        code: 'authorization-code-leak',
        profile: { email: 'hidden@example.com' },
      }],
    })
    expect(parsed).toEqual([{ id: 'anthropic', name: 'Anthropic', available: true, authenticated: true }])
    const serialized = JSON.stringify(parsed)
    for (const marker of ['sk-ant', 'leak', 'Authorization', 'refresh']) expect(serialized).not.toContain(marker)
  })

  it('parseLogoutAccounts keeps only the documented account summary fields', () => {
    const parsed = parseLogoutAccounts({
      accounts: [{
        credentialId: 7,
        provider: 'anthropic',
        label: 'me@example.com',
        detail: 'Team plan',
        type: 'oauth',
        active: true,
        token: 'sk-ant-oat01-leak',
        access_token: 'access-leak',
        refresh_token: 'refresh-leak',
        expiresAt: 9_999_999_999,
        scopes: ['user:profile'],
        blob: { session: 'opaque-session-blob' },
      }],
    })
    expect(parsed).toEqual([{ credentialId: 7, provider: 'anthropic', label: 'me@example.com', detail: 'Team plan', type: 'oauth', active: true }])
    const serialized = JSON.stringify(parsed)
    for (const marker of ['leak', 'opaque-session-blob', 'expiresAt', 'scopes']) expect(serialized).not.toContain(marker)
  })

  it('login/logout results retain only providerId / remainingSource', () => {
    expect(parseLoginResult({ providerId: 'anthropic', token: 'leak', credential: { id: 1 } })).toEqual({ providerId: 'anthropic' })
    expect(parseLogoutResult({ remainingSource: 'env:OPENAI_API_KEY', accessToken: 'leak' })).toEqual({ remainingSource: 'env:OPENAI_API_KEY' })
  })

  it('does not truncate long labels into unbounded state', () => {
    const long = 'x'.repeat(10_000)
    const parsed = parseLogoutAccounts({ accounts: [{ credentialId: 1, provider: 'anthropic', label: long, detail: long, type: 'oauth', active: true }] })
    expect(parsed).toEqual([])
    expect(parseLoginProviders({ providers: [{ id: long, name: 'A', available: true, authenticated: false }] })).toEqual([])
  })

  it('pins the login flow timeout to the upstream 600-second OAuth window', () => {
    expect(LOGIN_FLOW_TIMEOUT_MS).toBe(600_000)
  })
})
