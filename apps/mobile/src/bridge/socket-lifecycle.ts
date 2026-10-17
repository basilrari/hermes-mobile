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
 * Scope, stated honestly: a socket does not stay open while hidden. The
 * renderer still asks for a ticket and arms its reconnect timer before the
 * constructor runs. That request path is the rest of HM-32, not this module.
 *
 * The close code is 1000. A script may send 1000 or 3000-4999; 1001 ("going
 * away") throws InvalidAccessError in Chromium, which is the Android WebView.
 * A close that throws is not "already closing": the socket stays tracked so
 * the next suspend can retry.
 */

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
let suspended = false

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
 */
export function resetSocketLifecycleForTests(): void {
  suspended = false
  live.clear()
  observers.clear()
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
  if (win.__hermesSocketLifecycleInstalled) return
  const Original = win.WebSocket
  if (typeof Original === 'function' && !(Original as { __hermesLifecycleTracked?: boolean }).__hermesLifecycleTracked) {
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
