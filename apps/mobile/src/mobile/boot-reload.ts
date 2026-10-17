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
 * `visibilitychange` that reports visible. Returns an unsubscribe for the waiter;
 * the caller must use it if the boot recovers by another route.
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

export function reloadWhenVisible(win: ReloadWindow = window as unknown as ReloadWindow): () => void {
  if (win.document.visibilityState === 'visible') {
    win.location.reload()
    return noop
  }

  const onVisible = (): void => {
    if (win.document.visibilityState !== 'visible') return
    win.document.removeEventListener('visibilitychange', onVisible)
    win.location.reload()
  }
  win.document.addEventListener('visibilitychange', onVisible)
  return () => win.document.removeEventListener('visibilitychange', onVisible)
}
