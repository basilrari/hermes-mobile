import { describe, expect, it } from 'vitest'

import { exactPathOverride } from './resolve-override'
import { ROOMS_UNAVAILABLE_HINT, roomsOnlyMode } from './rooms-only'

const TARGET = '/repo/apps/desktop/src/plugins/hermes-bots/canonical-group-capabilities.ts'
const SHIM = '/repo/apps/mobile/src/overrides/canonical-group-capabilities.ts'
const IMPORTER = '/repo/apps/desktop/src/plugins/hermes-bots/roster-pane.tsx'
const ALIAS = { prefix: '@', root: '/repo/apps/desktop/src' }

function resolve(source: string, importer?: string) {
  const hook = exactPathOverride({
    name: 'test',
    target: TARGET,
    shim: SHIM,
    excludeImporter: SHIM,
    alias: ALIAS,
  }).resolveId as unknown as (s: string, i?: string) => string | null
  return hook(source, importer)
}

describe('roomsOnlyMode (HM-14)', () => {
  it('demotes the device-local branch to unavailable', () => {
    expect(roomsOnlyMode('legacy')).toBe('unavailable')
  })

  it('leaves the other two modes exactly as they are', () => {
    expect(roomsOnlyMode('canonical')).toBe('canonical')
    expect(roomsOnlyMode('unavailable')).toBe('unavailable')
  })

  it('is total over the mode union — no mode can reach the device-room branch', () => {
    for (const mode of ['canonical', 'legacy', 'unavailable'] as const) {
      expect(roomsOnlyMode(mode)).not.toBe('legacy')
    }
  })

  it('the hint points at the setup doc', () => {
    expect(ROOMS_UNAVAILABLE_HINT).toContain('docs/GATEWAY_SETUP.md')
  })
})

describe('exactPathOverride', () => {
  it('redirects a relative import of the target', () => {
    expect(resolve('./canonical-group-capabilities', IMPORTER)).toBe(SHIM)
    expect(resolve('./canonical-group-capabilities.ts', IMPORTER)).toBe(SHIM)
  })

  it('redirects a parent-relative import from a deeper module', () => {
    expect(resolve('../canonical-group-capabilities', '/repo/apps/desktop/src/plugins/hermes-bots/ui/tab.tsx')).toBe(SHIM)
  })

  it('does NOT redirect a parent-relative path that lands elsewhere', () => {
    // ../hermes-bots from src/app/chat is src/app/hermes-bots — a different module.
    expect(resolve('../hermes-bots/canonical-group-capabilities', '/repo/apps/desktop/src/app/chat/view.tsx')).toBeNull()
  })

  it('silently misses an aliased import when no alias is configured — the failure mode that matters', () => {
    const hook = exactPathOverride({ name: 'test', target: TARGET, shim: SHIM }).resolveId as unknown as (
      s: string,
      i?: string,
    ) => string | null
    expect(hook('@/plugins/hermes-bots/canonical-group-capabilities', IMPORTER)).toBeNull()
  })

  it('redirects the aliased form once the alias root is configured', () => {
    expect(resolve('@/plugins/hermes-bots/canonical-group-capabilities', '/repo/apps/desktop/src/app/chat/view.tsx')).toBe(SHIM)
  })

  it('never redirects the shim’s own import of the original (no self-import)', () => {
    expect(resolve('@/plugins/hermes-bots/canonical-group-capabilities', SHIM)).toBeNull()
    expect(resolve('./canonical-group-capabilities', SHIM)).toBeNull()
  })

  it('leaves every other module alone', () => {
    expect(resolve('./relay', IMPORTER)).toBeNull()
    expect(resolve('@/plugins/hermes-bots/group-chat', IMPORTER)).toBeNull()
    expect(resolve('canonical-group-capabilities', IMPORTER)).toBeNull() // bare specifier, not a path
    expect(resolve('./canonical-group-capabilities', undefined)).toBeNull()
  })

  it('handles Windows separators', () => {
    const hook = exactPathOverride({
      name: 'test',
      target: 'C:\\repo\\apps\\desktop\\src\\plugins\\hermes-bots\\canonical-group-capabilities.ts',
      shim: SHIM,
    }).resolveId as unknown as (s: string, i?: string) => string | null
    expect(hook('./canonical-group-capabilities', 'C:\\repo\\apps\\desktop\\src\\plugins\\hermes-bots\\pane.tsx')).toBe(SHIM)
  })
})
