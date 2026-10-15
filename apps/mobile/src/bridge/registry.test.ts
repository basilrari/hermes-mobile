import { beforeEach, describe, expect, it, vi } from 'vitest'

// Registry-route half of the bridge, added when the renderer was synced to
// upstream main for Bot Mode. Same mocking approach as bridge.test.ts.
const { httpSpy } = vi.hoisted(() => ({ httpSpy: vi.fn() }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  CapacitorHttp: { request: httpSpy },
}))

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

import {
  getConnection,
  getConnectionFor,
  getProfileRoutes,
  mobileConnectionId,
} from './connection'
import { api } from './http'
import { installBridge } from './install-bridge'
import { setTarget } from './state'

const TARGET = { baseUrl: 'https://box.tail1234.ts.net', authMode: 'token' as const, provider: null, token: 't' }

beforeEach(() => {
  httpSpy.mockReset()
})

describe('mobileConnectionId', () => {
  it('is deterministic per gateway host', () => {
    expect(mobileConnectionId('https://box.tail1234.ts.net')).toBe('mobile-box-tail1234-ts-net')
    expect(mobileConnectionId('http://100.64.0.1:9119')).toBe('mobile-100-64-0-1-9119')
  })
})

describe('registry routes (Bot Mode)', () => {
  beforeEach(async () => {
    await setTarget(TARGET)
  })

  it('getConnection carries a connectionId (required for canonical groups)', async () => {
    const conn = await getConnection()
    expect(conn.connectionId).toBe('mobile-box-tail1234-ts-net')
    expect(conn.mode).toBe('remote')
    expect(conn.wsUrl).toBe('wss://box.tail1234.ts.net/api/ws?token=t')
  })

  it('getConnectionFor rides the primary backend (sharedRemote) with the profile', async () => {
    const conn = await getConnectionFor({ connectionId: 'mobile-box-tail1234-ts-net', profile: 'researcher' })
    expect(conn.sharedRemote).toBe(true)
    expect(conn.profile).toBe('researcher')
    expect(conn.baseUrl).toBe(TARGET.baseUrl)
  })

  it('getProfileRoutes maps every profile to the one remote source', async () => {
    const routes = await getProfileRoutes(['researcher', ' writer ', 'researcher'])
    expect(routes.map((r) => r.profile)).toEqual(['default', 'researcher', 'writer'])
    for (const r of routes) {
      expect(r).toMatchObject({ connectionId: 'mobile-box-tail1234-ts-net', mode: 'remote', primary: true })
      expect(r.targetProfile).toBe(r.profile)
    }
  })
})

describe('installed bridge contract', () => {
  it('exposes the members the upstream renderer + Bot Mode call', () => {
    vi.stubGlobal('window', {})
    installBridge()
    const d = (globalThis.window as unknown as { hermesDesktop: Record<string, unknown> }).hermesDesktop
    for (const k of [
      'api',
      'getConnection',
      'getConnectionFor',
      'getGatewayWsUrl',
      'getGatewayWsUrlFor',
      'getProfileRoutes',
      'claimAmbientCue',
      'getSyncStatus',
      'updateHold',
      'quickEntry',
      'petOverlay',
      'findInPage',
    ]) {
      expect(d[k], k).toBeDefined()
    }
  })
})

describe('requests issued before the target is restored', () => {
  it('wait for the target instead of failing', async () => {
    await setTarget(null)
    httpSpy.mockResolvedValue({ status: 200, data: { profiles: [] }, headers: {} })
    const pending = api({ path: '/api/profiles' })
    await new Promise((r) => setTimeout(r, 10))
    expect(httpSpy).not.toHaveBeenCalled()
    await setTarget(TARGET)
    await expect(pending).resolves.toEqual({ profiles: [] })
    expect(httpSpy.mock.calls[0][0].url).toBe('https://box.tail1234.ts.net/api/profiles')
  })
})
