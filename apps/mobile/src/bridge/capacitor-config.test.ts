import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The one invariant in this PR whose regression leaks credentials: `loggingBehavior`
 * left at Capacitor's default. `'production'` sets `loggingEnabled = true` for the
 * whole bridge, and `Bridge.callPluginMethod` then writes every plugin payload —
 * the CapacitorHttp `Cookie` / `X-Hermes-Session-Token` headers and the login
 * password body — to logcat on the shipping APK.
 *
 * Read as text, not imported: `capacitor.config.ts` sits outside
 * `tsconfig.app.json`'s include and carries three pre-existing enum-literal
 * diagnostics (`SystemBarsStyle`, `KeyboardResize`), so importing it here would
 * put those into `npm run typecheck`. The generated
 * `android/app/src/main/assets/capacitor.config.json` is git-ignored, so the
 * source file is the only artefact `git diff` can watch.
 */
const configPath = fileURLToPath(new URL('../../capacitor.config.ts', import.meta.url))

/**
 * Strip what cannot be a setting: block comments, and `//` comments that start a
 * line or follow whitespace. The rationale comment beside the setting names it, so
 * a guard that ignored comments would go red on prose — the wrong report. Where
 * the heuristic is ambiguous it strips nothing, so the failure mode is a false red,
 * never a false green.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

/** The config with comments removed, so prose cannot satisfy or trip the guard. */
function activeSource(): string {
  return stripComments(fs.readFileSync(configPath, 'utf8'))
}

const KEY = /\bloggingBehavior\s*:/

describe('capacitor config (HM-32 credential guard)', () => {
  it('does not turn on bridge-wide logging', () => {
    expect(activeSource()).not.toMatch(KEY)
  })

  it('ignores the key in a comment and still sees it in code', () => {
    expect(stripComments("/* never set loggingBehavior: 'production' */")).not.toMatch(KEY)
    expect(stripComments("  webDir: 'dist', // keep loggingBehavior: 'production' out")).not.toMatch(KEY)
    expect(stripComments("  loggingBehavior: 'production',")).toMatch(KEY)
  })
})
