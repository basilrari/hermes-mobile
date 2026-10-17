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

// `'debug'` IS Capacitor's default (`CapConfig` sets `loggingEnabled = isDebug`,
// false on a non-debuggable APK), so writing it explicitly is a no-op and must not
// fail here — a false red on a safe value teaches people to work around the guard.
if (
  config !== null &&
  typeof config === 'object' &&
  'loggingBehavior' in config &&
  config.loggingBehavior !== 'debug'
) {
  console.error(
    `capacitor config check: the synced config sets loggingBehavior=${JSON.stringify(config.loggingBehavior)}.\n` +
      "Any value other than Capacitor's default ('debug') turns on bridge-wide logging, which puts the\n" +
      'CapacitorHttp Cookie / X-Hermes-Session-Token headers and the login password body in\n' +
      "release logcat. Leave it unset in capacitor.config.ts and re-run `cap sync`.",
  )
  process.exit(1)
}

console.log('capacitor config check: no loggingBehavior in the synced config — bridge logging stays off')
