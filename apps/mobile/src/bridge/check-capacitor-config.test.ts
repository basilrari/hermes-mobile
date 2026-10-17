/**
 * Pins the exit codes of `scripts/check-capacitor-config.mjs` (HM-32, round 11).
 *
 * That script guards the one invariant in this branch whose regression puts the
 * session token and the login password into logcat, and it is otherwise untested:
 * `capacitor.config.ts` sits outside this project's `tsconfig`, and the
 * artefact it reads is git-ignored, so no other test and no diff can see it. A
 * guard that can silently become a no-op is not a guard.
 *
 * The rule is `'none'` and nothing else: `CapConfig.java` maps `'production'` to
 * `loggingEnabled = true`, `'none'` to false, and a missing key or `'debug'` to
 * `isDebug` — true in a debuggable APK, and `assembleDebug` is the only build this
 * repo produces. The nested `android.loggingBehavior` key wins over the top-level
 * one in `CapConfig.java`, and `cap sync` writes both through verbatim.
 *
 * The script takes an optional fixture path as its first argument so these cases
 * can drive it without touching a real synced artefact.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../../../scripts/check-capacitor-config.mjs', import.meta.url))
const dir = mkdtempSync(path.join(tmpdir(), 'cap-config-check-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Write a fixture config and run the guard against it. */
function run(contents: string | null, name: string): { status: number; stderr: string; stdout: string } {
  const file = path.join(dir, name)
  if (contents !== null) writeFileSync(file, contents)
  try {
    const stdout = execFileSync(process.execPath, [script, file], { encoding: 'utf8', stdio: 'pipe' })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const e = error as { status?: number; stderr?: string; stdout?: string }
    return { status: e.status ?? -1, stderr: e.stderr ?? '', stdout: e.stdout ?? '' }
  }
}

describe('scripts/check-capacitor-config.mjs (HM-32)', () => {
  it("passes on the value the app sets: 'none'", () => {
    const result = run('{"loggingBehavior":"none"}', 'none.json')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('bridge logging off')
  })

  it('fails when the key is absent, because the default is ON in a debug APK', () => {
    const result = run('{"appId":"io.github.basilrari.hermesmobile"}', 'clean.json')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no loggingBehavior')
  })

  it("fails on 'debug', which is isDebug and therefore on in a debuggable APK", () => {
    expect(run('{"loggingBehavior":"debug"}', 'debug.json').status).toBe(1)
  })

  it("fails on 'production'", () => {
    const result = run('{"loggingBehavior":"production"}', 'production.json')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('loggingBehavior="production"')
  })

  it('fails on the nested android key the native side prefers', () => {
    // `CapConfig.java` reads `android.loggingBehavior` before `loggingBehavior`,
    // and `cap sync` writes the whole extConfig verbatim — a top-level-only check
    // passes this shape and leaks.
    const result = run('{"android":{"loggingBehavior":"production"}}', 'nested-production.json')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('android.loggingBehavior="production"')
  })

  it('passes on a nested key that is off, and on an android block without one', () => {
    expect(run('{"android":{"loggingBehavior":"none"}}', 'nested-none.json').status).toBe(0)
    expect(run('{"loggingBehavior":"none","android":{"buildOptions":{}}}', 'android-no-key.json').status).toBe(0)
  })

  it('judges the effective value when both keys are present', () => {
    // The nested key wins, so a stale top-level 'production' under a nested 'none'
    // is not a leak — and a red there would send the reader to the wrong key.
    expect(run('{"loggingBehavior":"production","android":{"loggingBehavior":"none"}}', 'both-safe.json').status).toBe(0)
    expect(run('{"loggingBehavior":"none","android":{"loggingBehavior":"production"}}', 'both-leaky.json').status).toBe(1)
  })

  it("accepts 'NONE' in any case, because CapConfig lowercases before its switch", () => {
    expect(run('{"loggingBehavior":"NONE"}', 'upper-none.json').status).toBe(0)
  })

  it('fails on a non-string value, which Capacitor stringifies away from the safe case', () => {
    // `JSONObject.getString` stringifies the member, so `["none"]` reaches the
    // switch as `[\"none\"]`, misses 'none' and lands on `default: isDebug` — on in
    // a debug APK. Coercing it here would certify that (round 16).
    expect(run('{"loggingBehavior":["none"]}', 'array-value.json').status).toBe(1)
  })

  it('fails closed on a value it does not recognise', () => {
    expect(run('{"android":{"loggingBehavior":"verbose"}}', 'unknown.json').status).toBe(1)
  })

  it('fails when the artefact is not a config object', () => {
    // A truncated or wrong-shaped `cap sync` output must not read as "no key".
    const nullRoot = run('null', 'null.json')
    expect(nullRoot.status).toBe(1)
    expect(nullRoot.stderr).toContain('is not a config object')
    expect(run('[]', 'array.json').stderr).toContain('is not a config object')
  })

  it('fails when the artefact is missing rather than skipping', () => {
    const result = run(null, 'absent.json')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no synced config at')
  })

  it('fails on an artefact that is not JSON', () => {
    expect(run('{not json', 'broken.json').status).toBe(1)
  })
})
