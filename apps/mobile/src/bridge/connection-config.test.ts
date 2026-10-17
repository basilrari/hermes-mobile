import { describe, expect, it } from 'vitest'

import {
  authModeFromStatus,
  buildApiUrl,
  buildGatewayWsUrl,
  buildGatewayWsUrlWithTicket,
  connectionScopeKey,
  isGatewayWsUrl,
  normalizeRemoteBaseUrl,
  pathWithProfileQuery,
} from './connection-config'

describe('normalizeRemoteBaseUrl', () => {
  it('strips trailing slash, hash, and query', () => {
    expect(normalizeRemoteBaseUrl('https://gw:9119/?x=1#h')).toBe('https://gw:9119')
  })
  it('rejects http://', () => {
    expect(() => normalizeRemoteBaseUrl('http://gw:9119')).toThrow(
      'Gateway URL must use https://. http:// and ws:// are not allowed.',
    )
  })
  it('rejects ws://', () => {
    expect(() => normalizeRemoteBaseUrl('ws://gw:9119/api/ws')).toThrow(
      'Gateway URL must use https://. http:// and ws:// are not allowed.',
    )
  })
  it('accepts https://', () => {
    expect(normalizeRemoteBaseUrl('https://gw:9119')).toBe('https://gw:9119')
  })
  it('accepts wss://', () => {
    expect(normalizeRemoteBaseUrl('wss://gw:9119')).toBe('https://gw:9119')
  })
  it('rejects other non-https schemes', () => {
    expect(() => normalizeRemoteBaseUrl('ftp://gw')).toThrow(/https:\/\//)
  })
  it('rejects an empty URL', () => {
    expect(() => normalizeRemoteBaseUrl('')).toThrow()
  })
})

describe('authModeFromStatus', () => {
  it('auth_required:true → oauth (a login gate)', () => {
    expect(authModeFromStatus({ auth_required: true })).toBe('oauth')
  })
  it('everything else → token', () => {
    expect(authModeFromStatus({ auth_required: false })).toBe('token')
    expect(authModeFromStatus({})).toBe('token')
    expect(authModeFromStatus(null)).toBe('token')
  })
})

describe('ws url builders', () => {
  // The builder is deliberately scheme-agnostic. https-only is enforced in normalizeRemoteBaseUrl.
  it('token mode embeds an (encoded) ?token=', () => {
    expect(buildGatewayWsUrl('http://gw:9119', 'tok en')).toBe('ws://gw:9119/api/ws?token=tok%20en')
  })
  it('derives wss:// from an https:// base', () => {
    expect(buildGatewayWsUrl('https://gw', 'x')).toBe('wss://gw/api/ws?token=x')
    expect(buildGatewayWsUrl('https://gw:9119', 'x')).toBe('wss://gw:9119/api/ws?token=x')
    expect(buildGatewayWsUrlWithTicket('https://gw:9119', 'abc')).toBe(
      'wss://gw:9119/api/ws?ticket=abc',
    )
  })
  it('oauth mode embeds ?ticket=', () => {
    expect(buildGatewayWsUrlWithTicket('http://gw:9119', 'abc')).toBe('ws://gw:9119/api/ws?ticket=abc')
  })
  it('honors a base path prefix', () => {
    expect(buildGatewayWsUrl('http://gw/hermes', 't')).toBe('ws://gw/hermes/api/ws?token=t')
  })
})

describe('isGatewayWsUrl', () => {
  // Feed the predicate what the builders actually emit, not a literal. Every hop
  // that decides *whether the control runs at all* — the suspend close, the
  // constructor close, the toast dismissal — hangs off this test: if a builder's
  // route or prefix shape stops ending in `/api/ws`, this fails. Hand-written
  // literals elsewhere would keep the suite green with all three as no-ops
  // (round 22 W2).
  it('accepts the URL both builders produce, for a bare host and a prefixed base', () => {
    for (const base of ['https://gw:9119', 'https://gw', 'https://gw/hermes', 'https://gw/hermes/']) {
      expect(isGatewayWsUrl(buildGatewayWsUrl(base, 'tok'))).toBe(true)
      expect(isGatewayWsUrl(buildGatewayWsUrlWithTicket(base, 'tick'))).toBe(true)
    }
  })

  it('rejects the sibling streams the wrapper must not force-close', () => {
    expect(isGatewayWsUrl('wss://gw/api/display/ws?ticket=d')).toBe(false)
    expect(isGatewayWsUrl('wss://gw/api/plugins/bots/events?token=x')).toBe(false)
    expect(isGatewayWsUrl('wss://gw/api/audio/transcribe-stream')).toBe(false)
    expect(isGatewayWsUrl(null)).toBe(false)
    expect(isGatewayWsUrl('not a url')).toBe(false)
  })
})

describe('connectionScopeKey', () => {
  it('blank/null collapses to the primary (null)', () => {
    expect(connectionScopeKey(null)).toBeNull()
    expect(connectionScopeKey('')).toBeNull()
    expect(connectionScopeKey('  ')).toBeNull()
  })
  it('trims a named profile', () => {
    expect(connectionScopeKey(' iris ')).toBe('iris')
  })
})

describe('pathWithProfileQuery', () => {
  it('appends ?profile= for a named profile', () => {
    expect(pathWithProfileQuery('/api/model/info', 'iris')).toBe('/api/model/info?profile=iris')
  })
  it('preserves existing query params', () => {
    expect(pathWithProfileQuery('/api/model/options?force=1', 'iris')).toBe(
      '/api/model/options?force=1&profile=iris',
    )
  })
  it('does not replace an explicit profile query', () => {
    expect(pathWithProfileQuery('/api/x?profile=default', 'iris')).toBe('/api/x?profile=default')
  })
  it('no-ops for the primary (null/blank) profile', () => {
    expect(pathWithProfileQuery('/api/x', null)).toBe('/api/x')
    expect(pathWithProfileQuery('/api/x', '')).toBe('/api/x')
  })
})

describe('buildApiUrl', () => {
  it('joins base + path, honoring a prefix', () => {
    expect(buildApiUrl('http://gw:9119', '/api/status')).toBe('http://gw:9119/api/status')
    expect(buildApiUrl('http://gw/hermes', 'api/x')).toBe('http://gw/hermes/api/x')
  })
})
