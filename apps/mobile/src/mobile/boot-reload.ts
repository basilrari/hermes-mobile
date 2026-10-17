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
 * So: reload now if the app is on screen, otherwise wait. Two edges can bring it
 * on screen and they arrive in either order — `visibilitychange` (the WebView) and
 * the app-state channel (the activity) — so the waiter re-checks on both and
 * reloads when the condition holds, rather than sampling it once on the first
 * edge (round 16). Sampling loses the reload when the WebView reports visible
 * before `onResume` clears the gate, and nothing would wake the waiter again.
 *
 * The wait is bounded, and the bound does NOT reload blind — a reload while hidden
 * is the defect above, on a clock instead of on a signal. At `timeoutMs` the waiter
 * reports the stall through `onTimeout` (the caller drops its "Reconnecting…" cover
 * and the manual failure screen takes over) and stays armed. That closes the dead
 * end — a boot parked on a cover with nothing scheduled — without a hidden dial.
 *
 * Returns an unsubscribe for the waiter; the caller must use it if the boot
 * recovers by another route.
 */
import { isSuspended } from '~bridge/socket-lifecycle'

export interface ReloadWindow {
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  location: Pick<Location, 'reload'>
}

export interface ReloadOptions {
  /** How long to wait hidden before reporting the stall, in ms. */
  timeoutMs?: number
  /** Called once when the wait exceeds `timeoutMs`. The reload stays armed. */
  onTimeout?: () => void
  /**
   * Whether a reload is safe now. Defaults to "the page is visible AND the suspend
   * gate is open": the WebView and the activity are two truths, and the gate is
   * the one the branch's whole invariant is defined by.
   */
  isOnScreen?: () => boolean
  /**
   * Subscribe to the platform's foreground channel (the caller wires
   * `onAppStateChange`). Its edge is the other half of `isOnScreen`, so the waiter
   * must listen to it too. Returns an unsubscribe.
   */
  watchResume?: (recheck: () => void) => () => void
}

/** Default bound on the deferred wait, in ms. */
export const HIDDEN_RELOAD_TIMEOUT_MS = 60_000

const noop = (): void => {}

export function reloadWhenVisible(
  win: ReloadWindow = window as unknown as ReloadWindow,
  {
    timeoutMs = HIDDEN_RELOAD_TIMEOUT_MS,
    onTimeout,
    isOnScreen,
    watchResume,
  }: ReloadOptions = {},
): () => void {
  const onScreen = isOnScreen ?? ((): boolean => win.document.visibilityState === 'visible' && !isSuspended())

  if (onScreen()) {
    win.location.reload()
    return noop
  }

  let armed = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let unwatchResume: () => void = noop

  const stop = (): void => {
    armed = false
    win.document.removeEventListener('visibilitychange', tryReload)
    unwatchResume()
    unwatchResume = noop
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const reload = (): void => {
    stop()
    win.location.reload()
  }

  /** Both edges land here: reload only while the whole condition holds. */
  function tryReload(): void {
    if (!armed || !onScreen()) return
    reload()
  }

  win.document.addEventListener('visibilitychange', tryReload)
  unwatchResume = watchResume?.(tryReload) ?? noop

  // Report the stall; do not reload. A reload here is the hidden dial this module
  // exists to prevent (round 12), so the waiter stays armed for either edge.
  timer = setTimeout(() => {
    timer = undefined
    onTimeout?.()
  }, timeoutMs)
  return stop
}
