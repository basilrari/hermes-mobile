/**
 * connection.ts — the connection-descriptor half of the bridge.
 *
 * Implements `getConnection` / `getGatewayWsUrl` from the window.hermesDesktop
 * contract. The vendored desktop `store/gateway.ts` + `lib/gateway-ws-url.ts`
 * call these before every connect; `getGatewayWsUrl` mints a FRESH single-use
 * ws-ticket each time (30s TTL, single-use), exactly as the desktop main
 * process does.
 */

import type { HermesConnection } from '@/global'

import { mintWsTicket } from './auth'
import { buildGatewayWsUrl, buildGatewayWsUrlWithTicket } from './connection-config'
import { awaitTarget } from './state'

function requireTarget() {
  return awaitTarget()
}

/**
 * Stable registry-style id for the saved gateway. The upstream renderer keys
 * everything route-scoped (Bot Mode canonical groups, per-connection rosters,
 * profile sockets) on `HermesConnection.connectionId`; Electron's main process
 * fills it from its connections registry. Mobile has exactly one remote target,
 * so derive a deterministic id from its normalized base URL.
 */
export function mobileConnectionId(baseUrl: string): string {
  let host = baseUrl
  try {
    const u = new URL(baseUrl)
    host = `${u.hostname}${u.port ? `-${u.port}` : ''}`
  } catch {
    /* keep raw */
  }
  return `mobile-${host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
}

/** Build the WS URL the gateway client connects with. OAuth/password gateways
 *  mint a fresh ticket; token gateways embed the long-lived token. */
export async function getGatewayWsUrl(): Promise<string> {
  const target = await requireTarget()
  if (target.authMode === 'oauth') {
    const ticket = await mintWsTicket(target.baseUrl)
    return buildGatewayWsUrlWithTicket(target.baseUrl, ticket)
  }
  // token mode: the saved static session token rides in the ws URL (?token=),
  // matching the desktop's buildGatewayWsUrl(baseUrl, token).
  return buildGatewayWsUrl(target.baseUrl, target.token ?? '')
}

/** Resolve a full connection descriptor. `wsUrl` is minted fresh so a cached
 *  descriptor is always connectable; the vendored re-mint path also re-calls
 *  getGatewayWsUrl on each connect. */
export async function getConnection(): Promise<HermesConnection> {
  const target = await requireTarget()
  const wsUrl = await getGatewayWsUrl()
  return {
    baseUrl: target.baseUrl,
    isFullscreen: false,
    mode: 'remote',
    authMode: target.authMode,
    connectionId: mobileConnectionId(target.baseUrl),
    remoteKind: 'url',
    nativeOverlayWidth: 0,
    source: 'settings',
    // token gateways carry the static token; oauth authenticates via cookies.
    token: target.authMode === 'token' ? (target.token ?? '') : '',
    wsUrl,
    logs: [],
    windowButtonPosition: null,
  }
}

/**
 * Registry-scoped resolution (`getConnectionFor`). Electron resolves a
 * (connectionId, profile) pair against its connections registry; on mobile the
 * only source is the saved remote gateway, which serves every profile on that
 * one host (profile_home multiplexing). So any route resolves to the primary
 * descriptor tagged `sharedRemote`, which tells the renderer to ride the
 * primary socket with a `profile` param instead of dialing a duplicate
 * secondary WebSocket to the same backend (upstream #96493).
 */
export async function getConnectionFor(payload?: {
  connectionId?: null | string
  profile?: null | string
}): Promise<HermesConnection> {
  const base = await getConnection()
  const profile = String(payload?.profile ?? '').trim()
  return {
    ...base,
    ...(profile && profile !== 'default' ? { profile, sharedRemote: true } : { sharedRemote: true }),
  }
}

export async function getGatewayWsUrlFor(): Promise<string> {
  return getGatewayWsUrl()
}

/** Credential-free plugin routes (`getProfileRoutes`) for Bot Mode et al.:
 *  every profile name the renderer knows lives on the one remote gateway. */
export async function getProfileRoutes(profiles: string[]) {
  const target = await requireTarget()
  const connectionId = mobileConnectionId(target.baseUrl)
  const names = Array.isArray(profiles)
    ? [...new Set(profiles.filter((p) => typeof p === 'string').map((p) => p.trim()).filter(Boolean))]
    : []
  if (!names.includes('default')) names.unshift('default')
  return names.slice(0, 256).map((profile) => ({
    connectionId,
    mode: 'remote' as const,
    primary: true as const,
    profile,
    targetProfile: profile,
  }))
}
