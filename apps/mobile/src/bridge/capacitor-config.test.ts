import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The one invariant in this PR whose regression leaks credentials: bridge-wide
 * logging must resolve to off. `CapConfig.java` maps `'production'` to
 * `loggingEnabled = true`, `'none'` to false, and a missing key (or `'debug'`) to
 * `isDebug` — true in a debuggable APK, and `assembleDebug` is the only build this
 * repo produces. With the logger on, `Bridge.callPluginMethod` writes every plugin
 * payload — the CapacitorHttp `Cookie` / `X-Hermes-Session-Token` headers and the
 * login password body — to logcat. So the source must say `'none'`; an absent key
 * is the leak, not the safe default (round 14).
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

const KEY = /\bloggingBehavior\s*:\s*(['"])([^'"]*)\1/

/** The `loggingBehavior` value in a config source, or `undefined` if absent. */
export function loggingBehaviorOf(source: string): string | undefined {
  return KEY.exec(stripComments(source))?.[2]
}

describe('capacitor config (HM-32 credential guard)', () => {
  it("sets loggingBehavior to 'none', the only value that is off in a debug APK", () => {
    expect(loggingBehaviorOf(activeSource())).toBe('none')
  })

  it('reads the value from code, not from a comment', () => {
    expect(loggingBehaviorOf("/* never set loggingBehavior: 'production' */ webDir: 'dist'")).toBe(undefined)
    expect(loggingBehaviorOf("  webDir: 'dist', // keep loggingBehavior: 'production' out")).toBe(undefined)
    expect(loggingBehaviorOf("  loggingBehavior: 'production',")).toBe('production')
    expect(loggingBehaviorOf('  loggingBehavior: "none",')).toBe('none')
  })
})
