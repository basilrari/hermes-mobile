/**
 * Assert the SYNCED Capacitor config does not turn on bridge-wide logging (HM-32).
 *
 * `capacitor.config.ts` leaves `loggingBehavior` at Capacitor's default on purpose:
 * `'production'` sets `loggingEnabled = true` for the whole bridge and
 * `Bridge.callPluginMethod` then writes every plugin payload to logcat — the
 * CapacitorHttp request headers (`Cookie`, `X-Hermes-Session-Token`) and the login
 * password body. That is the only credential path in this app's config.
 *
 * `src/bridge/capacitor-config.test.ts` guards the same invariant in the source
 * file, but the file Capacitor actually consumes is the generated
 * `android/app/src/main/assets/capacitor.config.json`, and it is git-ignored — so
 * no diff can show the key coming back and no test reads it (round 10). This runs
 * where the artefact is produced: `npm run cap:sync` calls `cap sync` and then
 * this check, so the shipping JSON cannot carry the key and stay green.
 *
 * A missing artefact is a failure, not a skip: a guard that cannot fail is not a
 * guard. The exit codes are pinned by
 * `apps/mobile/src/bridge/check-capacitor-config.test.ts`; an optional first
 * argument points the check at a fixture instead of the real artefact.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const artefact =
  process.argv[2] ??
  fileURLToPath(new URL('../apps/mobile/android/app/src/main/assets/capacitor.config.json', import.meta.url))

let raw
try {
  raw = readFileSync(artefact, 'utf8')
} catch {
  console.error(
    `capacitor config check: no synced config at ${artefact}\n` +
      'Run this through `npm run cap:sync` in apps/mobile (it generates the artefact this checks).',
  )
  process.exit(1)
}

let config
try {
  config = JSON.parse(raw)
} catch (error) {
  console.error(`capacitor config check: ${artefact} is not valid JSON (${error.message})`)
  process.exit(1)
}

// Only `'production'` turns bridge-wide logging ON (`CapConfig.java`):
//   'production' → loggingEnabled = true
//   'none'       → loggingEnabled = false
//   'debug'      → loggingEnabled = isDebug   (false on a non-debuggable APK)
// So `'debug'` and `'none'` are safe values a developer may write explicitly, and
// only `'production'` — or any value this file does not know — is a failure. A
// false red on a safe value is how people learn to route around a guard.
const SAFE_BEHAVIORS = new Set(['debug', 'none'])
const DEFAULT_BEHAVIOR = 'debug'

// Both keys are checked, because the native side prefers the nested one:
// `CapConfig.java` reads `android.loggingBehavior` first and falls back to
// `loggingBehavior`, and `cli/tasks/copy.js` writes the whole `extConfig` into the
// artefact verbatim — so `{"android":{"loggingBehavior":"production"}}` reaches
// release logcat. A top-level-only guard passes that shape (round 11).
const keys =
  config !== null && typeof config === 'object'
    ? [
        ['loggingBehavior', config.loggingBehavior],
        ['android.loggingBehavior', config.android?.loggingBehavior],
      ]
    : []

const setting = keys.find(([, value]) => value !== undefined)
const leaking = keys.find(([, value]) => value !== undefined && !SAFE_BEHAVIORS.has(String(value)))

if (leaking) {
  const [key, value] = leaking
  console.error(
    `capacitor config check: the synced config sets ${key}=${JSON.stringify(value)}.\n` +
      "Only Capacitor's safe values ('debug' — the default — and 'none') leave bridge-wide logging\n" +
      'off. Anything else puts the CapacitorHttp Cookie / X-Hermes-Session-Token headers and the\n' +
      'login password body in release logcat. Leave the key unset in capacitor.config.ts and re-run\n' +
      '`cap sync`.',
  )
  process.exit(1)
}

console.log(
  `capacitor config check: loggingBehavior stays off (${setting ? `${setting[0]}=${JSON.stringify(setting[1])}` : `no key, default '${DEFAULT_BEHAVIOR}'`})`,
)
