/**
 * resolve-override.ts — the generic mobile override rule (HM-16 mechanism,
 * first used by HM-11 and reused by HM-14).
 *
 * The rule redirects ONE upstream module to a mobile one, matched on the
 * RESOLVED target path so it catches every importer — relative (`./x`,
 * `../../plugins/hermes-bots/x`) and aliased (`@/plugins/hermes-bots/x`) alike.
 *
 * Safety rails, in order of how much damage a mistake would do:
 *  - `excludeImporter`: the shim itself must be able to import the ORIGINAL (it
 *    wraps it), so its own import is never redirected. Without this the shim
 *    would import itself and the bundle would fail to build.
 *  - `enforce: 'pre'` so a redirect happens before Vite's resolver.
 *  - the target is a single file path, never a directory or a bare package
 *    name, so an override can never capture a wider graph than intended.
 */
import path from 'node:path'

import type { Plugin } from 'vite'

export interface ExactPathOverrideOptions {
  /** Plugin name suffix, e.g. 'canonical-rooms'. */
  name: string
  /** Absolute path of the upstream module being replaced. */
  target: string
  /** Absolute path of the mobile module that replaces it. */
  shim: string
  /** Absolute path of the shim, whose OWN import of `target` is left alone. */
  excludeImporter?: string
  /**
   * The bundler alias that maps to the upstream source root (e.g. `@` →
   * `apps/desktop/src`). Without it an aliased import
   * (`@/plugins/hermes-bots/x`) cannot be matched and would silently keep the
   * upstream module.
   */
  alias?: { prefix: string; root: string }
}

const toPosix = (value: string): string => value.replace(/\\/g, '/')
const withoutExtension = (value: string): string => value.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '')

export function exactPathOverride(options: ExactPathOverrideOptions): Plugin {
  const target = withoutExtension(toPosix(options.target))
  const exclude = options.excludeImporter ? toPosix(options.excludeImporter) : null

  return {
    name: `hermes-mobile:${options.name}`,
    enforce: 'pre',
    resolveId(source: string, importer?: string): string | null {
      if (!importer) return null
      const importerPath = toPosix(importer)
      // The shim wraps the original; never redirect its own import.
      if (exclude && importerPath === exclude) return null

      // A relative specifier resolves against the importer's directory; an
      // aliased one against the alias root; anything else (a bare package name)
      // is never a path we own.
      let candidate = source
      if (source.startsWith('.')) {
        candidate = path.posix.join(path.posix.dirname(importerPath), source)
      } else if (options.alias && (source === options.alias.prefix || source.startsWith(`${options.alias.prefix}/`))) {
        candidate = path.posix.join(options.alias.root, source.slice(options.alias.prefix.length))
      }

      return withoutExtension(candidate) === target ? options.shim : null
    },
  } as Plugin
}
