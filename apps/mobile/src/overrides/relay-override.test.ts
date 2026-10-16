import { describe, expect, it } from 'vitest'

import { hermesMobileRelayOverride } from './relay-override'

const SHIM = '/repo/apps/mobile/src/overrides/hermes-bots-relay.ts'
const PLUGIN_TSX = '/repo/apps/desktop/src/plugins/hermes-bots/plugin.tsx'

/** `resolveId` is a plain function in this plugin; call it directly. */
function resolve(plugin: ReturnType<typeof hermesMobileRelayOverride>, source: string, importer?: string) {
  const hook = plugin.resolveId as unknown as (s: string, i?: string) => string | null
  return hook(source, importer)
}

describe('hermesMobileRelayOverride', () => {
  const plugin = hermesMobileRelayOverride(SHIM)

  it('redirects the hermes-bots plugin `./relay` import to the mobile shim', () => {
    expect(resolve(plugin, './relay', PLUGIN_TSX)).toBe(SHIM)
  })

  it('is scoped: a different importer keeps its own ./relay', () => {
    expect(resolve(plugin, './relay', '/repo/apps/desktop/src/plugins/other/plugin.tsx')).toBeNull()
    expect(resolve(plugin, './relay', undefined)).toBeNull()
  })

  it('is scoped: a different specifier is untouched', () => {
    expect(resolve(plugin, './relay-budget', PLUGIN_TSX)).toBeNull()
    expect(resolve(plugin, '@/plugins/hermes-bots/relay', PLUGIN_TSX)).toBeNull()
  })

  it('handles Windows separators in the importer path', () => {
    expect(resolve(plugin, './relay', 'C:\\repo\\apps\\desktop\\src\\plugins\\hermes-bots\\plugin.tsx')).toBe(SHIM)
  })

  it('the shim exports the two relay doors as no-ops', async () => {
    const shim = await import('./hermes-bots-relay')
    expect(typeof shim.startBotRelay).toBe('function')
    expect(typeof shim.stopBotRelay).toBe('function')
    expect(shim.startBotRelay()).toBeUndefined()
    expect(shim.stopBotRelay()).toBeUndefined()
  })
})
