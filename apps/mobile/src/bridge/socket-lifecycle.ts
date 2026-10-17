/**
 * socket-lifecycle.ts — drop the gateway socket when the app is backgrounded.
 *
 * Android keeps a hidden WebView's sockets open, and an open socket counts as
 * network activity: the radio stays busy and the process stays warm while the
 * user is not looking at the app. The renderer owns the socket. This module
 * closes tracked GATEWAY sockets on the way out, and closes a gateway socket the
 * renderer opens while the app is still hidden. The client dials on close, not on
 * resume
 * (`scheduleReconnect` in the vendored boot hook), so a flag that is only read
 * on the way out leaves the new socket up until the next background edge.
 *
 * This is deliberately NOT part of rpc-trace.ts. `VITE_HERMES_TRACE=false` is
 * the documented release knob and leaves the whole trace inert; nothing in this
 * repo sets it today, so a build usually ships the trace — but the control must
 * not depend on that. Here the dependency runs the other way: the trace registers
 * as an observer of this module, and a gap note reaches it when one exists
 * (lifecycle-gap.ts).
 *
 * Scope, stated honestly: the GATEWAY socket does not stay open while hidden,
 * including on the failure path. Siblings are not touched — plugin streams
 * (`/api/plugins/…`), dictation (`/api/audio/transcribe-stream`) and the Bot
 * Screen RFB stream (`/api/display/ws`) have no resume path of their own, so a
 * close here strands them: the RFB pane re-attaches out of `conn === 'idle'` on
 * `disconnect`, the wrapper closes that fresh socket in its constructor, noVNC
 * takes its `_fail` path (`clean: false`) and the pane parks on "stream lost"
 * with nothing to re-attach it (`screen-pane.tsx`, `@novnc/novnc` 1.7
 * `rfb.js` `_socketClose`). Their background traffic is HM-32's remaining work,
 * not something to buy by breaking the pane. The flag starts `false` in a fresh
 * module instance, so a reload would re-arm the gate while the app is still
 * hidden; `BootAutoRetry` therefore reloads only once the app is on screen again
 * (`reloadWhenVisible`, `boot-reload.ts`). Within a hidden window the renderer
 * still arms its reconnect timer before the constructor runs; the dial itself is
 * refused while suspended (the gate in `connection.ts`), and the request
 * reduction HM-32's acceptance line asks for is that issue's remaining task, not
 * this module's.
 *
 * The close code is 1000. A script may send 1000 or 3000-4999; 1001 ("going
 * away") throws InvalidAccessError in Chromium, which is the Android WebView.
 * A close that throws is not "already closing": the socket stays tracked, and
 * a re-asserted suspend (`setSuspended(true)` while already suspended, or
 * `closeGatewaySockets()`) retries it. `appStateChange` does not deliver a second
 * `isActive: false` while the app stays hidden, so that retry guards this
 * module's contract, not an event the plugin emits.
 */

import { isGatewayWsUrl } from './connection-config'
import { reportLifecycleGap, resetLifecycleGapForTests } from './lifecycle-gap'

/** The subset of WebSocket this module relies on. */
export interface SocketLike {
  /** The URL the socket was constructed with. Optional on purpose: observers
   *  (`mobile-behaviors.tsx`'s open watch) read it to tell the gateway socket
   *  from its siblings, but the close rule does NOT — it keys on the URL the
   *  wrapper was handed, because an absent property here is indistinguishable
   *  from "this is a sibling" and would skip the close in silence (round 23). */
  url?: string
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: () => void): void
}

/** The subset of the window this module touches, so tests can pass a fake. */
export interface LifecycleWindow {
  WebSocket?: unknown
  __hermesSocketLifecycleInstalled?: boolean
}

type Observer = (socket: SocketLike) => void

/**
 * Socket → the URL the wrapper was given when it constructed it. The URL is
 * captured there rather than read off the socket: `SocketLike.url` is optional,
 * and an implementation that does not expose it would otherwise be classified
 * as a sibling and never closed (round 23).
 */
const live = new Map<SocketLike, string>()
const observers = new Set<Observer>()
/**
 * Owner: `MobileBehaviors` (`apps/mobile/src/mobile/mobile-behaviors.tsx`). It
 * is the only caller of `setSuspended`, driven by Capacitor `appStateChange`,
 * and it clears the flag on MOUNT (and on `appStateChange(true)`): the auth path
 * (401 → `requireReauth`) unmounts that component while the app is hidden, and
 * `AppPlugin` does not replay `isActive: true` to the listener the next mount
 * registers, so a flag left set would gate every dial on a visible app. It is
 * deliberately NOT cleared on unmount: that unmount happens in the background,
 * and the resolver outlives the component (`store/profile.ts`, `api/plugins.ts`,
 * `store/gateway.ts`), so opening the gate there would let a dial mint a ticket
 * behind a screen nobody is looking at (round 14).
 */
let suspended = false
/** One `console.warn` per window-less install, so a missing constructor is not spam. */
let warnedMissingConstructor = false

/** Legal in Chromium. 1001 is reserved and throws from script. */
const CLOSE_CODE = 1000
const CLOSE_REASON = 'app backgrounded'

/** Sockets this module is currently holding open. */
export function liveSocketCount(): number {
  return live.size
}

/** True while the app is backgrounded. New sockets opened in that window are closed. */
export function isSuspended(): boolean {
  return suspended
}

/**
 * Did this window get the socket-lifecycle wrapper? Exported so other modules
 * (`rpc-trace`) ask instead of reading a copy of the flag name — a rename here
 * cannot leave a reader looking at a key nothing sets.
 */
export function isSocketLifecycleInstalled(win: object = globalThis): boolean {
  return (win as { __hermesSocketLifecycleInstalled?: boolean }).__hermesSocketLifecycleInstalled === true
}

/** Watch every socket the renderer opens. Returns an unsubscribe. */
export function onSocketCreated(observer: Observer): () => void {
  observers.add(observer)
  return () => {
    observers.delete(observer)
  }
}

/**
 * When the HM-32 gate last refused a dial (epoch ms). The gate lives in
 * `connection.ts` and the boot loop only ever sees the thrown failure, so this
 * is how "refused by the gate" is told apart from every other boot failure.
 * `isSuspended()` alone cannot do it: it answers for the whole hidden window, so
 * a genuine 401 during a backgrounded boot would be classified as transient and
 * take the retry loop the vendored hook reserves for remote faults.
 */
let dialSuppressedAtMs = 0

/**
 * How long a gate refusal stays attributable to the attempt being classified.
 * The gate throws and the boot hook's catch reads this in the same tick, so a
 * couple of seconds is generous; an older mark belongs to an earlier attempt.
 */
export const DIAL_SUPPRESSED_FRESH_MS = 2_000

/** Record a refused dial. Called by the gate itself, nowhere else. */
export function noteDialSuppressed(nowMs = Date.now()): void {
  dialSuppressedAtMs = nowMs
}

/** A dial that passed the gate clears the mark: it then describes the last attempt only. */
export function clearDialSuppressed(): void {
  dialSuppressedAtMs = 0
}

/** True when a dial refusal is recent enough to be the current failure. */
export function dialSuppressedRecently(nowMs = Date.now(), withinMs = DIAL_SUPPRESSED_FRESH_MS): boolean {
  return dialSuppressedAtMs !== 0 && nowMs - dialSuppressedAtMs <= withinMs
}

/**
 * Drop tracked sockets, the suspension flag, and observers. Tests share this
 * module's globals; a window-local install flag does not reset them.
 *
 * Ships in the bundle — only tests call it — and it clears the suspend gate as
 * well as the socket registry, so nothing in the app may use it.
 */
export function resetSocketLifecycleForTests(): void {
  // It ships in the bundle, so make a mistaken call from app code fail loudly in a
  // production build instead of silently opening the gate (round 8).
  if (import.meta.env.PROD) throw new Error('resetSocketLifecycleForTests is test-only')
  suspended = false
  dialSuppressedAtMs = 0
  live.clear()
  observers.clear()
  warnedMissingConstructor = false
  resetLifecycleGapForTests()
}

/**
 * Close one socket. Returns false when `close` throws, and leaves the socket
 * tracked so a later pass can retry. A throw is not "already closing."
 */
function closeTracked(socket: SocketLike, code = CLOSE_CODE, reason = CLOSE_REASON): boolean {
  try {
    socket.close(code, reason)
  } catch {
    return false
  }
  live.delete(socket)
  return true
}

/**
 * Close every tracked GATEWAY socket. Returns how many `close` calls returned.
 * A call that throws does not count, and that socket stays in the set.
 *
 * Siblings (`/api/plugins/…`, dictation, Bot Screen RFB) are held to their own
 * lifecycles: only the gateway socket has a redial on resume (`reconnectNow`),
 * so closing them here is a stream lost with nothing to bring it back — see the
 * module header.
 */
export function closeGatewaySockets(code = CLOSE_CODE, reason = CLOSE_REASON): number {
  let closed = 0
  for (const [socket, url] of [...live]) {
    if (!isGatewayWsUrl(url)) continue
    if (closeTracked(socket, code, reason)) closed++
  }
  return closed
}

/**
 * Background/foreground the gateway socket layer. Suspending closes the gateway
 * socket, and a repeat suspend retries any close that threw. Resuming only
 * clears the flag, so the renderer's next dial proceeds normally.
 */
export function setSuspended(next: boolean): void {
  if (next === suspended) {
    if (next && live.size > 0) closeGatewaySockets()
    return
  }
  suspended = next
  if (next) closeGatewaySockets()
}

/**
 * Wrap `globalThis.WebSocket` so every socket opened by the vendored renderer is
 * tracked. Idempotent. Must run before any socket is created (boot.ts), and runs
 * whether or not tracing is enabled.
 */
export function installSocketLifecycle(win: LifecycleWindow = globalThis as unknown as LifecycleWindow): void {
  if (isSocketLifecycleInstalled(win)) return
  const Original = win.WebSocket
  if (typeof Original !== 'function') {
    // Fail visibly, once. Marking the window installed here (the round-3 shape)
    // made an unwrapped constructor indistinguishable from a wrapped one, and
    // `isSocketLifecycleInstalled()` also routes `installRpcTrace` to the
    // observer branch — so tracing went quiet in the same breath. The only
    // observable of that failure was "the battery did not improve".
    // The note goes to the console AND to the RPC trace (lifecycle-gap.ts): the
    // trace is metadata-only and is what the app can show on-device, which
    // `console.*` cannot on a release APK.
    if (!warnedMissingConstructor) {
      warnedMissingConstructor = true
      reportLifecycleGap('WebSocket is not a constructor: socket lifecycle NOT installed')
    }
    return
  }
  if (!(Original as { __hermesLifecycleTracked?: boolean }).__hermesLifecycleTracked) {
    const Wrapped = function (this: unknown, url: string, protocols?: string | string[]): SocketLike {
      const socket =
        protocols === undefined
          ? new (Original as unknown as new (u: string) => SocketLike)(url)
          : new (Original as unknown as new (u: string, p: string | string[]) => SocketLike)(url, protocols)

      live.set(socket, url)
      // Only `close` untracks. `error` can fire on a socket that is still open
      // (a TLS/connection error on the wire does not always close it), and an
      // untracked-but-open socket is one the next background cannot close.
      const forget = (): void => {
        live.delete(socket)
      }
      try {
        socket.addEventListener('close', forget)
      } catch {
        /* tracking must never break the app */
      }

      for (const observer of [...observers]) {
        try {
          observer(socket)
        } catch {
          /* one bad observer must not stop the others */
        }
      }

      // The renderer dials on close. Closing here is the same close, applied
      // to a socket it already constructed — not a stand-in for that socket.
      // Gateway only, like `closeGatewaySockets`: a sibling's owner is the one
      // that knows how to bring it back. The URL is the one this wrapper was
      // handed, not `socket.url` (optional — round 23).
      if (suspended && isGatewayWsUrl(url)) closeTracked(socket)
      return socket
    }
    ;(Wrapped as unknown as { prototype: unknown }).prototype = (Original as { prototype: unknown }).prototype
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      const value = (Original as unknown as Record<string, unknown>)[key]
      if (value !== undefined) (Wrapped as unknown as Record<string, unknown>)[key] = value
    }
    ;(Wrapped as { __hermesLifecycleTracked?: boolean }).__hermesLifecycleTracked = true
    win.WebSocket = Wrapped
  }
  win.__hermesSocketLifecycleInstalled = true
}
