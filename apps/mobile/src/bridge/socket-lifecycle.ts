/**
 * socket-lifecycle.ts — drop the gateway socket when the app is backgrounded.
 *
 * Android keeps a hidden WebView's sockets open, and an open socket counts as
 * network activity: the radio stays busy and the process stays warm while the
 * user is not looking at the app. The renderer owns the socket, so the only
 * mobile-side lever is to close it on the way out and let the renderer's own
 * reconnect logic dial again on the way back.
 *
 * This is deliberately NOT part of rpc-trace.ts. The trace is off in a release
 * build (`installRpcTrace` returns early), so anything that has to work in the
 * shipped app cannot live behind that flag. Here the dependency runs the other
 * way: the trace registers as an observer of this module.
 *
 * Scope, stated honestly: this closes the socket. It does not stop the renderer
 * from dialling again while the app is hidden — that reconnect loop lives in the
 * vendored renderer, and gating it is an upstream change. What this does buy is
 * that the held-open socket, and the polling that goes with it, end the moment
 * the app is backgrounded.
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

/** Sockets this module is currently holding open. */
export function liveSocketCount(): number {
  return live.size
}

/** True while the app is backgrounded and the sockets have been dropped. */
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
 * Close every tracked socket. Returns how many were closed. Code 1001 ("going
 * away") is the honest one: the client, not the server, is the reason.
 */
export function closeAllSockets(code = 1001, reason = 'app backgrounded'): number {
  const sockets = [...live]
  live.clear()
  for (const socket of sockets) {
    try {
      socket.close(code, reason)
    } catch {
      /* a socket already closing must not break the suspension path */
    }
  }
  return sockets.length
}

/**
 * Background/foreground the socket layer. Suspending closes everything; resuming
 * only clears the flag, so the renderer's next dial proceeds normally.
 */
export function setSuspended(next: boolean): void {
  if (next === suspended) return
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
