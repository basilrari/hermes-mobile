/**
 * lifecycle-gap.ts — a one-way channel for "this control switched itself off".
 *
 * `socket-lifecycle` and `native.ts` both have a failure mode whose only
 * observable is silence: a `WebSocket` that is not a constructor, or a rejected
 * `App.addListener('appStateChange')`, leaves the socket open while the app is
 * hidden and nothing else in the app would ever say so. The symptom is "the
 * battery did not improve".
 *
 * Why not `loggingBehavior: 'production'` in capacitor.config.ts (round 5): that
 * value sets `loggingEnabled = true` for the WHOLE bridge, and
 * `Bridge.callPluginMethod` then logs every plugin payload — the
 * `CapacitorHttp.request` headers (Cookie, X-Hermes-Session-Token) and body
 * (the login password), and the saved-token `Preferences.set` values. Credentials
 * in logcat on the shipping build is a worse trade than a silent gap.
 *
 * So the console line stays (debug builds, chrome://inspect), and the trace
 * takes a note: `rpc-trace` registers a reporter here, which keeps the
 * dependency one-way — `rpc-trace.ts` imports `socket-lifecycle.ts`, so the
 * lifecycle module cannot record into the trace directly.
 */

type Reporter = (message: string) => void

let reporter: Reporter | null = null
/** Notes raised before a reporter registered (boot installs lifecycle before trace). */
let pending: string[] = []

/**
 * Record that a control could not be installed. Always leaves a console line;
 * also hands the message to the trace when one is listening (now or later).
 */
export function reportLifecycleGap(message: string): void {
  console.warn(`[hm-32] ${message}`)
  if (!reporter) {
    pending.push(message)
    return
  }
  deliver(reporter, message)
}

/** Register the sink. Returns an unsubscribe. Flushes anything raised earlier. */
export function onLifecycleGap(next: Reporter): () => void {
  reporter = next
  const queued = pending
  pending = []
  for (const message of queued) deliver(next, message)
  return () => {
    if (reporter === next) reporter = null
  }
}

/** Drops the sink and anything queued. Tests share this module's globals. */
export function resetLifecycleGapForTests(): void {
  reporter = null
  pending = []
}

function deliver(next: Reporter, message: string): void {
  try {
    next(message)
  } catch {
    /* a gap note must never break boot */
  }
}
