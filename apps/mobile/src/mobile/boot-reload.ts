/**
 * boot-reload.ts — reload the app, but only while it is on screen (HM-32).
 *
 * `BootAutoRetry` reloads after a cold boot that ran out of retries. A reload
 * re-runs the bridge modules, so the HM-32 suspend flag starts at `false`
 * (`socket-lifecycle.ts`) and nothing sets it again until the next
 * `appStateChange(false)` — which the plugin does not replay while the app stays
 * hidden. Reloading in the background therefore lets the next boot dial, mint a
 * fresh ws-ticket and keep that socket open for the rest of the hidden window:
 * the exact symptom this branch exists to prevent, reached through the failure
 * path (round 10).
 *
 * So: reload now if the app is visible, otherwise wait for the next
 * `visibilitychange` that reports visible. The wait is bounded, and the bound
 * does NOT reload blind — a reload while hidden is the defect above, on a clock
 * instead of on a signal. At `timeoutMs` the waiter reports the stall through
 * `onTimeout` (the caller drops its "Reconnecting…" cover and the manual failure
 * screen takes over) and stays armed for the visible edge. That closes the dead
 * end — a boot parked on a cover with nothing scheduled — without a hidden dial.
 *
 * Returns an unsubscribe for the waiter; the caller must use it if the boot
 * recovers by another route.
 *
 * `document.visibilityState` is the signal `@capacitor/app`'s own web
 * implementation maps to `appStateChange`, so this module reads the same truth
 * the rest of the branch does.
 */
export interface ReloadWindow {
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  location: Pick<Location, 'reload'>
}

export interface ReloadOptions {
  /** How long to wait hidden before reporting the stall, in ms. */
  timeoutMs?: number
  /** Called once when the wait exceeds `timeoutMs`. The reload stays armed. */
  onTimeout?: () => void
}

/** Default bound on the deferred wait, in ms. */
export const HIDDEN_RELOAD_TIMEOUT_MS = 60_000

const noop = (): void => {}

export function reloadWhenVisible(
  win: ReloadWindow = window as unknown as ReloadWindow,
  { timeoutMs = HIDDEN_RELOAD_TIMEOUT_MS, onTimeout }: ReloadOptions = {},
): () => void {
  if (win.document.visibilityState === 'visible') {
    win.location.reload()
    return noop
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  const stop = (): void => {
    win.document.removeEventListener('visibilitychange', onVisible)
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const reload = (): void => {
    stop()
    win.location.reload()
  }

  const onVisible = (): void => {
    if (win.document.visibilityState !== 'visible') return
    reload()
  }
  win.document.addEventListener('visibilitychange', onVisible)

  // Report the stall; do not reload. A reload here is the hidden dial this module
  // exists to prevent (round 12), so the waiter stays armed for the visible edge.
  timer = setTimeout(() => {
    timer = undefined
    onTimeout?.()
  }, timeoutMs)
  return stop
}
