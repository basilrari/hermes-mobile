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
 * `visibilitychange` that reports visible. The wait is bounded rather than open
 * (`HIDDEN_RELOAD_FALLBACK_MS`): the fallback fires whether the signal is
 * missing or the app is simply still hidden, because a boot parked on the cover
 * with nothing scheduled is worse than the one dial it costs. Returns an
 * unsubscribe for the waiter; the caller must use it if the boot recovers by
 * another route.
 *
 * `document.visibilityState` is the signal `@capacitor/app`'s own web
 * implementation maps to `appStateChange`, so this module reads the same truth
 * the rest of the branch does.
 */
export interface ReloadWindow {
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  location: Pick<Location, 'reload'>
}

const noop = (): void => {}

/** Upper bound on the deferred wait, in ms, before reloading anyway. */
export const HIDDEN_RELOAD_FALLBACK_MS = 60_000

export function reloadWhenVisible(
  win: ReloadWindow = window as unknown as ReloadWindow,
  fallbackMs: number = HIDDEN_RELOAD_FALLBACK_MS,
): () => void {
  if (win.document.visibilityState === 'visible') {
    win.location.reload()
    return noop
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  // One exit path for both the visible edge and the fallback: drop the listener,
  // drop the timer, reload once.
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
  // Bounded fallback: an open-ended wait leaves the boot stuck behind the
  // "Reconnecting…" cover with its retry budget unspent and nothing scheduled if
  // the platform never reports visible (a WebView that does not flip
  // `visibilityState` on resume, an OEM launcher). One dial after a minute is the
  // cheaper failure — the same dial this branch already accepts elsewhere (round 11).
  timer = setTimeout(reload, fallbackMs)
  return stop
}
