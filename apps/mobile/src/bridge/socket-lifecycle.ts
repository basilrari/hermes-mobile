/**
 * socket-lifecycle.ts — drop the gateway socket when the app is backgrounded.
 *
 * Android keeps a hidden WebView's sockets open, and an open socket counts as
 * network activity: the radio stays busy and the process stays warm while the
 * user is not looking at the app. The renderer owns the socket. This module
 * closes tracked sockets on the way out, and closes any the renderer opens
 * while the app is still hidden. The client dials on close, not on resume
 * (`scheduleReconnect` in the vendored boot hook), so a flag that is only read
 * on the way out leaves the new socket up until the next background edge.
 *
 * This is deliberately NOT part of rpc-trace.ts. The trace is off in a release
 * build (`installRpcTrace` returns early), so anything that has to work in the
 * shipped app cannot live behind that flag. Here the dependency runs the other
 * way: the trace registers as an observer of this module.
 *
 * Scope, stated honestly: a socket does not stay open while hidden. The renderer
 * still arms its reconnect timer before the constructor runs; the dial itself is
 * refused while suspended (the gate in `connection.ts`), and the request
 * reduction HM-32's acceptance line asks for is that issue's remaining task, not
 * this module's.
 *
 * The close code is 1000. A script may send 1000 or 3000-4999; 1001 ("going
 * away") throws InvalidAccessError in Chromium, which is the Android WebView.
 * A close that throws is not "already closing": the socket stays tracked, and
 * a re-asserted suspend (`setSuspended(true)` while already suspended, or
 * `closeAllSockets()`) retries it. `appStateChange` does not deliver a second
 * `isActive: false` while the app stays hidden, so that retry guards this
 * module's contract, not an event the plugin emits.
 */

import { reportLifecycleGap, resetLifecycleGapForTests } from './lifecycle-gap'

/** The subset of WebSocket this module relies on. */
export interface SocketLike {
  readyState: number
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: () => void): void
}

/** The subset of the window this module touches, so tests can pass a fake. */
export interface LifecycleWindow {
  WebSocket?: unknown
  __hermesSocketLifecycleInstalled?: boolean
}

type Observer = (socket: SocketLike) => void

const live = new Set<SocketLike>()
const observers = new Set<Observer>()
/**
 * Owner: `MobileBehaviors` (`apps/mobile/src/mobile/mobile-behaviors.tsx`). It
 * is the only caller of `setSuspended`, driven by Capacitor `appStateChange`,
 * and it clears the flag on mount and unmount as well as on resume: the auth
 * path (401 → `requireReauth`) unmounts that component while the app is hidden,
 * and `AppPlugin` does not replay `isActive: true` to the listener the next
 * mount registers. A flag left set gates every dial on a visible app.
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
 * Drop tracked sockets, the suspension flag, and observers. Tests share this
 * module's globals; a window-local install flag does not reset them.
 *
 * Ships in the bundle — only tests call it — and it clears the suspend gate as
 * well as the socket registry, so nothing in the app may use it.
 */
export function resetSocketLifecycleForTests(): void {
  suspended = false
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
 * Close every tracked socket. Returns how many `close` calls returned.
 * A call that throws does not count, and that socket stays in the set.
 */
export function closeAllSockets(code = CLOSE_CODE, reason = CLOSE_REASON): number {
  let closed = 0
  for (const socket of [...live]) {
    if (closeTracked(socket, code, reason)) closed++
  }
  return closed
}

/**
 * Background/foreground the socket layer. Suspending closes everything, and a
 * repeat suspend retries any close that threw. Resuming only clears the flag,
 * so the renderer's next dial proceeds normally.
 */
export function setSuspended(next: boolean): void {
  if (next === suspended) {
    if (next && live.size > 0) closeAllSockets()
    return
  }
  suspended = next
  if (next) closeAllSockets()
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

      live.add(socket)
      const forget = (): void => {
        live.delete(socket)
      }
      try {
        socket.addEventListener('close', forget)
        socket.addEventListener('error', forget)
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
      if (suspended) closeTracked(socket)
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
