import { beforeEach, describe, expect, it, vi } from 'vitest'

// The bridge talks to the gateway through CapacitorHttp on-device. Mock the
// native HTTP stack so we can assert exactly what the bridge sends (URL, headers,
// method) and simulate gateway responses. isNativePlatform:true selects the
// CapacitorHttp path (http.ts picks it at module load).
const { httpSpy } = vi.hoisted(() => ({ httpSpy: vi.fn() }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  CapacitorHttp: { request: httpSpy },
}))

// Preferences backs the target store + cookie jar; an in-memory map is enough.
vi.mock('@capacitor/preferences', () => {
  const store = new Map<string, string>()
  return {
    Preferences: {
      get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
      set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        store.set(key, value)
      }),
      remove: vi.fn(async ({ key }: { key: string }) => {
        store.delete(key)
      }),
    },
  }
})

import { mintWsTicket, passwordLogin, probeGateway } from './auth'
import { getConnection, getGatewayWsUrl, GatewayDialSuppressed } from './connection'
import { api } from './http'
import { dialSuppressedRecently, resetSocketLifecycleForTests, setSuspended } from './socket-lifecycle'
import { setTarget } from './state'

/** Shape of a CapacitorHttp response (responseType: 'json'). */
function res(status: number, data: unknown, headers: Record<string, string> = {}) {
  return { status, data, headers }
}
const ok = (data: unknown, headers?: Record<string, string>) => res(200, data, headers)

/** The single object CapacitorHttp.request was called with. */
const lastRequest = () => httpSpy.mock.calls.at(-1)?.[0] as { url: string; method: string; headers: Record<string, string> }

beforeEach(() => {
  httpSpy.mockReset()
})

describe('token-mode REST (api)', () => {
  beforeEach(async () => {
    await setTarget({ baseUrl: 'http://gw:9119', authMode: 'token', provider: null, token: 'secret-tok' })
  })

  it('sends the X-Hermes-Session-Token header', async () => {
    httpSpy.mockResolvedValue(ok({ ok: true }))
    await api({ path: '/api/model/info' })
    expect(lastRequest().url).toBe('http://gw:9119/api/model/info')
    expect(lastRequest().headers['X-Hermes-Session-Token']).toBe('secret-tok')
  })

  it('appends ?profile= for a profile-scoped call', async () => {
    httpSpy.mockResolvedValue(ok({}))
    await api({ path: '/api/model/info', profile: 'iris' })
    expect(lastRequest().url).toBe('http://gw:9119/api/model/info?profile=iris')
  })

  it('does not append profile for the primary (null) profile', async () => {
    httpSpy.mockResolvedValue(ok({}))
    await api({ path: '/api/x', profile: null })
    expect(lastRequest().url).toBe('http://gw:9119/api/x')
  })
})

describe('oauth-mode REST (api)', () => {
  it('authenticates by cookie — no static token header', async () => {
    await setTarget({ baseUrl: 'http://gw', authMode: 'oauth', provider: 'basic' })
    httpSpy.mockResolvedValue(ok({}))
    await api({ path: '/api/x' })
    expect(lastRequest().headers['X-Hermes-Session-Token']).toBeUndefined()
  })
})

describe('ws url', () => {
  it('token mode embeds the static token', async () => {
    await setTarget({ baseUrl: 'http://gw:9119', authMode: 'token', provider: null, token: 'abc' })
    expect(await getGatewayWsUrl()).toBe('ws://gw:9119/api/ws?token=abc')
  })

  it('oauth mode mints a FRESH ws-ticket on every call (renewal)', async () => {
    await setTarget({ baseUrl: 'http://gw:9119', authMode: 'oauth', provider: 'basic' })
    httpSpy.mockResolvedValueOnce(ok({ ticket: 't1' })).mockResolvedValueOnce(ok({ ticket: 't2' }))
    expect(await getGatewayWsUrl()).toBe('ws://gw:9119/api/ws?ticket=t1')
    expect(await getGatewayWsUrl()).toBe('ws://gw:9119/api/ws?ticket=t2')
    expect(httpSpy).toHaveBeenCalledTimes(2)
  })
})

describe('getConnection', () => {
  it('surfaces the token + remote mode for token gateways', async () => {
    await setTarget({ baseUrl: 'http://gw:9119', authMode: 'token', provider: null, token: 'zzz' })
    const c = await getConnection()
    expect(c.mode).toBe('remote')
    expect(c.token).toBe('zzz')
    expect(c.wsUrl).toContain('token=zzz')
  })
})

describe('gateway dial while the app is backgrounded (HM-32)', () => {
  beforeEach(async () => {
    resetSocketLifecycleForTests()
    await setTarget({ baseUrl: 'http://gw:9119', authMode: 'oauth', provider: 'basic' })
  })

  it('refuses the ticket and the dial while hidden — no background request', async () => {
    setSuspended(true)
    httpSpy.mockResolvedValue(ok({ ticket: 'never-minted' }))

    // A distinct type: callers that are not dialing can tell a suppressed dial
    // from a transport failure (round-4 review, connection.ts).
    await expect(getGatewayWsUrl()).rejects.toBeInstanceOf(GatewayDialSuppressed)
    await expect(getConnection()).rejects.toBeInstanceOf(GatewayDialSuppressed)
    await expect(getGatewayWsUrl()).rejects.toThrow(/backgrounded/i)
    expect(httpSpy).not.toHaveBeenCalled()

    // The gate records the refusal: that mark is the only way the boot hook's
    // retry decision (`getBootProgress().retryable`, stubs.ts) can tell a refused
    // dial from a real failure, since it never sees the error object.
    expect(dialSuppressedRecently()).toBe(true)
  })

  it('dials again as soon as the app is visible', async () => {
    setSuspended(true)
    httpSpy.mockResolvedValue(ok({ ticket: 't2' }))
    await expect(getGatewayWsUrl()).rejects.toThrow(/backgrounded/i)
    expect(dialSuppressedRecently()).toBe(true)

    setSuspended(false)

    expect(await getGatewayWsUrl()).toBe('ws://gw:9119/api/ws?ticket=t2')
    expect(httpSpy).toHaveBeenCalledTimes(1)
    // A dial that passed the gate clears the mark, so a boot failure after it is
    // not classified as a suppressed dial.
    expect(dialSuppressedRecently()).toBe(false)
  })
})

describe('passwordLogin', () => {
  it('maps 404 to a clear "no password login" error (OAuth-only gateways)', async () => {
    httpSpy.mockResolvedValue(res(404, { detail: 'not found' }))
    await expect(
      passwordLogin('http://gw', { provider: 'google', username: 'a', password: 'b' }),
    ).rejects.toThrow(/no password login/i)
  })

  it('maps 401 to invalid credentials', async () => {
    httpSpy.mockResolvedValue(res(401, {}))
    await expect(
      passwordLogin('http://gw', { provider: 'basic', username: 'a', password: 'b' }),
    ).rejects.toThrow(/invalid/i)
  })
})

describe('mintWsTicket', () => {
  it('returns the ticket from the gateway', async () => {
    httpSpy.mockResolvedValue(ok({ ticket: 'the-ticket', ttl_seconds: 30 }))
    expect(await mintWsTicket('http://gw')).toBe('the-ticket')
  })
  it('throws when the gateway returns no ticket', async () => {
    httpSpy.mockResolvedValue(ok({}))
    await expect(mintWsTicket('http://gw')).rejects.toThrow(/no ticket/i)
  })
})

describe('probeGateway', () => {
  it('classifies an auth_required gateway as oauth + lists providers + needsLogin', async () => {
    httpSpy
      .mockResolvedValueOnce(ok({ auth_required: true, version: '0.17.0' })) // /api/status
      .mockResolvedValueOnce(
        ok({ providers: [{ name: 'google', display_name: 'Google', supports_password: false }] }),
      ) // /api/auth/providers
    const p = await probeGateway('https://gw:9119')
    expect(p.authMode).toBe('oauth')
    expect(p.needsLogin).toBe(true)
    expect(p.providers).toEqual([{ name: 'google', displayName: 'Google', supportsPassword: false }])
  })

  it('classifies an open gateway as token with no providers', async () => {
    httpSpy.mockResolvedValueOnce(ok({ auth_required: false, version: '0.17.0' }))
    const p = await probeGateway('https://gw:9119')
    expect(p.authMode).toBe('token')
    expect(p.providers).toEqual([])
  })
})
