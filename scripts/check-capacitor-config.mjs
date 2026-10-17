/**
 * Assert the SYNCED Capacitor config does not turn on bridge-wide logging (HM-32).
 *
 * `loggingBehavior: 'none'` is the only value that leaves bridge logging off on
 * every build type: `'production'` sets `loggingEnabled = true`, `'none'` sets it
 * false, and `'debug'` (the default when the key is absent) sets it to `isDebug` —
 * which is TRUE on `assembleDebug`, the only APK this repo builds. With the logger
 * on, `Bridge.callPluginMethod` writes every plugin payload to logcat — the
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

// `CapConfig.java` (android 8.5.3) does:
//   'production' -> loggingEnabled = true
//   'none'       -> loggingEnabled = false
//   default      -> loggingEnabled = isDebug  (FLAG_DEBUGGABLE)
// and `package.json` only ever builds `assembleDebug`, which is debuggable by
// definition. So 'debug' and an absent key both turn the payload logger ON in the
// only APK this repo produces; 'none' is the one value that is off everywhere.
const SAFE_BEHAVIOR = 'none'
const DEFAULT_BEHAVIOR = 'debug'

if (config === null || typeof config !== 'object' || Array.isArray(config)) {
  console.error(
    `capacitor config check: ${artefact} is not a config object (${JSON.stringify(config)?.slice(0, 40)}).\n` +
      'That is a broken `cap sync` output, not a setting — re-run `npm run cap:sync`.',
  )
  process.exit(1)
}

// `CapConfig.java` resolves `android.loggingBehavior` FIRST and falls back to the
// top-level key, and `cli/tasks/copy.js` writes the whole extConfig verbatim — so
// the nested key is the one that decides, and a top-level-only reading can be a
// false green (round 11) or a false red on the safer shape (round 13).
const nested = config.android?.loggingBehavior
const effective = nested !== undefined ? nested : config.loggingBehavior
const effectiveKey = nested !== undefined ? 'android.loggingBehavior' : 'loggingBehavior'

if (effective === undefined) {
  console.error(
    `capacitor config check: the synced config sets no loggingBehavior, so Capacitor falls back to\n` +
      `'${DEFAULT_BEHAVIOR}' (loggingEnabled = isDebug) — which is ON in a debug APK, and \`assembleDebug\`\n` +
      'is the only build this repo produces. That puts the CapacitorHttp Cookie /\n' +
      'X-Hermes-Session-Token headers and the login password body in logcat. Set\n' +
      "`loggingBehavior: 'none'` in capacitor.config.ts and re-run `cap sync`.",
  )
  process.exit(1)
}

// `CapConfig.java:295` lowercases before its switch, so 'NONE' is the same off
// value — but only a STRING can be that value. `JSONObject.getString` stringifies a
// non-string member, so `["none"]` reaches the switch as `[\"none\"]`, misses the
// 'none' case and lands on `default: loggingEnabled = isDebug` (on in a debug APK).
// Coercing here would certify it (round 16).
if (typeof effective !== 'string' || effective.toLowerCase() !== SAFE_BEHAVIOR) {
  console.error(
    `capacitor config check: the synced config resolves ${effectiveKey}=${JSON.stringify(effective)}.\n` +
      `On a debug APK only '${SAFE_BEHAVIOR}' leaves bridge logging off ('debug' sets loggingEnabled =\n` +
      'isDebug, and `assembleDebug` is the only build this repo makes). Anything else puts the\n' +
      'CapacitorHttp Cookie / X-Hermes-Session-Token headers and the login password body in\n' +
      "release logcat. Set `loggingBehavior: 'none'` in capacitor.config.ts and re-run `cap sync`.",
  )
  process.exit(1)
}

console.log(`capacitor config check: bridge logging off on every build type (${effectiveKey}=${JSON.stringify(effective)})`)
