/**
 * boot-auto-retry.tsx — reload-retry a cold boot, but only while on screen (HM-32).
 *
 * Cold-launch connections sometimes time out because the Wi-Fi radio is still
 * waking from power-save (the foreground lock hasn't ramped it yet) — a reload a
 * second later, with the radio warm, connects fine. Rather than greet the user
 * with the failure screen, quietly reload-retry up to twice behind a
 * "Reconnecting…" cover; only after that does the manual BootFailureOverlay take
 * over. The counter lives in sessionStorage so it survives the reload, and is
 * cleared once the gateway connects.
 *
 * The cover is z-1500 and the recovery overlay is z-1400 (`styles.css`
 * `--z-setup`), so while this is mounted the manual surface is hidden. That is why
 * the deferred wait's bound (`boot-reload.ts`) hands control back here: it must
 * drop the cover, or a boot whose visibility signal never arrives sits under a
 * mask with its retry budget unspent (round 12).
 *
 * Split out of `app.tsx` so the failure path is executable in jsdom without
 * mounting the desktop renderer (round 13).
 */
import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { $desktopBoot } from '@/store/boot'
import { onAppStateChange } from '~bridge/native'
import { reloadWhenVisible } from '~mobile/boot-reload'

const RETRY_KEY = 'hermes-boot-retries'
const MAX_TRIES = 2
/** Give the radio a moment to warm before the reload replaces the page. */
const RELOAD_DELAY_MS = 1100

export function BootAutoRetry() {
  const boot = useStore($desktopBoot)
  const [retrying, setRetrying] = useState(false)
  const scheduled = useRef(false)
  // Set while a reload is waiting for the app to come back on screen.
  const cancelReload = useRef<null | (() => void)>(null)

  useEffect(() => {
    if (boot.running && !boot.error) {
      window.sessionStorage.removeItem(RETRY_KEY)
      // A boot that recovered by another route leaves this cover mounted over a
      // working app unless it is dropped here: the reload never fires, so the
      // cleanup below only cancels the waiter. The cover is z-1500 and the app
      // underneath is already usable (S3, round 21).
      setRetrying(false)
      return
    }

    if (boot.error && !boot.running && !scheduled.current) {
      const tries = Number(window.sessionStorage.getItem(RETRY_KEY) || '0')
      if (tries >= MAX_TRIES) return // give up — let BootFailureOverlay handle it
      scheduled.current = true
      window.sessionStorage.setItem(RETRY_KEY, String(tries + 1))
      setRetrying(true)
      const timer = window.setTimeout(() => {
        void window.hermesDesktop?.resetBootstrap?.()
        // HM-32: a reload re-runs the bridge modules, so the suspend gate starts
        // `false` again. Reloading while hidden would let the next boot dial, mint
        // a ticket and hold that socket for the rest of the hidden window — so wait
        // for the screen (`boot-reload.ts`). The wait is bounded, but the bound only
        // drops this cover so the failure screen can take over; it never reloads
        // blind, because that is the same hidden dial one step earlier.
        // Two edges can bring the app back and they arrive in either order: the
        // WebView's `visibilitychange` and the activity's `appStateChange`. The
        // waiter re-checks on both, so it cannot be woken by the first one before
        // the gate opens and then sit there forever (round 16).
        cancelReload.current = reloadWhenVisible(window, {
          onTimeout: () => setRetrying(false),
          watchResume: (recheck) => onAppStateChange((active) => (active ? recheck() : undefined)),
        })
      }, RELOAD_DELAY_MS)
      return () => {
        window.clearTimeout(timer)
        cancelReload.current?.()
        cancelReload.current = null
      }
    }
  }, [boot.running, boot.error])

  if (!retrying) return null
  return (
    <div className="fixed inset-0 z-[1500] grid place-items-center bg-(--ui-chat-surface-background) text-sm text-muted-foreground">
      Reconnecting…
    </div>
  )
}
