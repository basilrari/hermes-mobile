/**
 * overrides/relay-override.ts — the Vite rule that swaps in the mobile relay
 * no-op (HM-11).
 *
 * `plugin.tsx` imports the relay as `./relay`. A relative specifier cannot be
 * aliased by name, so this resolves that ONE import — identified by BOTH the
 * specifier and the importer — to the mobile shim. Nothing else in the renderer
 * is affected: another plugin's own `./relay` is left alone.
 */
import type { Plugin } from 'vite'

/** The upstream module whose `./relay` import is redirected. */
const RELAY_IMPORTER_SUFFIX = '/plugins/hermes-bots/plugin.tsx'
/** The specifier, exactly as upstream writes it. */
const RELAY_SPECIFIER = './relay'

export function hermesMobileRelayOverride(shimPath: string): Plugin {
  return {
    name: 'hermes-mobile:relay-override',
    // Run before Vite's own resolver so the relative import never resolves.
    enforce: 'pre',
    resolveId(source: string, importer?: string): string | null {
      if (source !== RELAY_SPECIFIER || !importer) return null
      if (!importer.replace(/\\/g, '/').endsWith(RELAY_IMPORTER_SUFFIX)) return null
      return shimPath
    },
  } as Plugin
}
