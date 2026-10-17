/**
 * native.ts — the handful of window.hermesDesktop methods that map cleanly onto
 * Capacitor plugins. Everything else is stubbed in stubs.ts.
 */

import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Clipboard } from '@capacitor/clipboard'
import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { LocalNotifications } from '@capacitor/local-notifications'
import { Share } from '@capacitor/share'

import type { HermesNotification } from '@/../electron/notification-types'

import { reportLifecycleGap } from './lifecycle-gap'

/**
 * Write `text` to a cache file and open the native share sheet (HM-05: the
 * debug RPC trace). Returns false when sharing is unavailable, so a caller can
 * fall back to the clipboard.
 */
export async function shareTextFile(fileName: string, text: string): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    return writeClipboard(text)
  }
  try {
    const written = await Filesystem.writeFile({
      path: fileName,
      data: text,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    })
    await Share.share({ title: fileName, url: written.uri, dialogTitle: 'Share Hermes trace' })
    return true
  } catch {
    // No share target, or Filesystem denied: clipboard is the honest fallback.
    return writeClipboard(text)
  }
}


export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await Clipboard.write({ string: text })
    return true
  } catch {
    return false
  }
}

export async function openExternal(url: string): Promise<void> {
  try {
    await Browser.open({ url })
  } catch {
    /* ignore — nothing actionable on the mobile side */
  }
}

let notifyId = 1
let notifPermissionAsked = false

export async function notify(payload: HermesNotification): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false
  try {
    if (!notifPermissionAsked) {
      notifPermissionAsked = true
      const perm = await LocalNotifications.checkPermissions()
      if (perm.display !== 'granted') {
        await LocalNotifications.requestPermissions()
      }
    }
    await LocalNotifications.schedule({
      notifications: [
        {
          id: notifyId++,
          title: payload.title ?? 'Hermes',
          body: payload.body ?? '',
          silent: payload.silent,
          extra: { sessionId: payload.sessionId, kind: payload.kind },
        },
      ],
    })
    return true
  } catch {
    return false
  }
}

/** Wire Capacitor's app-resume into a callback so the vendored reconnect-on-wake
 *  logic fires unchanged. Returns an unsubscribe. */
export function onPowerResume(callback: () => void): () => void {
  const handle = App.addListener('resume', () => callback())
  return () => {
    void handle.then((h) => h.remove())
  }
}

/**
 * Wire Capacitor's app foreground/background state into a callback (HM-32).
 * `active` is true when the app is on screen. Returns an unsubscribe.
 */
export function onAppStateChange(callback: (active: boolean) => void): () => void {
  // A rejected registration is caught so it cannot take down the effect that
  // owns the socket — but it must not be silent: this listener is the only
  // caller of `setSuspended`, so a plugin that fails to register means the
  // socket stays open on every background with nothing else to show for it
  // (HM-32 review). Note goes to the trace as well, which is readable on a
  // release build; `console.*` is not (lifecycle-gap.ts).
  const handle = App.addListener('appStateChange', ({ isActive }) => callback(isActive)).catch(
    (err: unknown) => {
      // `code` is the bounded field that separates Capacitor's rejections from one
      // another (`UNIMPLEMENTED` = the plugin is absent on this platform, …).
      // `name` cannot: `@capacitor/core` sets `message`/`code`/`data` and never
      // `name`, so every plugin rejection reads `Error` and a tablet owner learns
      // the control is off but not which way it failed (round 10, probed).
      // Still no free-form text: no message, no stack, no URL.
      const code = (err as { code?: unknown } | null)?.code
      const reason = typeof code === 'string' && code ? code : err instanceof Error ? err.name : typeof err
      // Two consequences, and the note names both: the socket is not closed on
      // background, and the deferred boot reload loses its only wake-up channel
      // (`boot-reload.ts` watches this event for the gate opening, round 17).
      //
      // Sized to survive the trace's clamp: `rpc-trace` prepends `lifecycle: ` (11
      // chars) and truncates past 120, and the truncation eats the TAIL — which is
      // the reason code, the one field that says which way the control failed
      // (round 18). Fixed part 74 chars, so 74 + 11 + 24 = 109 for the longest
      // possible reason.
      //
      // VALIDATED, not repaired (round 19): stripping the disallowed characters
      // joined free text (`'bad hunter2'` → `badhunter2`) and a repaired-then-sliced
      // 40-char token dropped below `scrubGapNote`'s 32-char redaction rule, where it
      // used to be redacted whole. Either the reason is already a code-shaped token
      // of bounded length, or it is `unknown`.
      const bounded = /^[A-Za-z0-9_.-]{1,24}$/.test(reason) ? reason : 'unknown'
      reportLifecycleGap(
        `appStateChange did not register: no background close, no reload wake-up (${bounded})`,
      )
      return null
    },
  )
  return () => {
    void handle.then((h) => h?.remove())
  }
}
