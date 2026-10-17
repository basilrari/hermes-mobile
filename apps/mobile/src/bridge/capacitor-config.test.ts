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

/** The file without comment lines, so the rationale comment cannot match the key. */
function activeSource(): string {
  return fs
    .readFileSync(configPath, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

describe('capacitor config (HM-32 credential guard)', () => {
  it('does not turn on bridge-wide logging', () => {
    expect(activeSource()).not.toMatch(/\bloggingBehavior\s*:/)
  })
})
