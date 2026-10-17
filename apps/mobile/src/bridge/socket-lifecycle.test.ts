import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  closeGatewaySockets,
  installSocketLifecycle,
  isSocketLifecycleInstalled,
  isSuspended,
  liveSocketCount,
  onSocketCreated,
  resetSocketLifecycleForTests,
  setSuspended,
} from './socket-lifecycle'

/** A stand-in for a real WebSocket: records close calls, fires listeners.
 *  Rejects a code Chromium would reject, so a suite cannot go green on 1001.
 *  Carries the URL it was constructed with — the module scopes its close by it. */
function fakeSocket(url = 'wss://gw.example/api/ws') {
  const listeners = new Map<string, Array<() => void>>()
  const closed: Array<{ code?: number; reason?: string }> = []
  return {
    readyState: 1,
    url,
    closed,
    close(code?: number, reason?: string) {
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
        const err = new Error(
          `Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
        )
        err.name = 'InvalidAccessError'
        throw err
      }
      closed.push({ code, reason })
      this.readyState = 3
      for (const fn of listeners.get('close') ?? []) fn()
    },
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    emit(type: string) {
      for (const fn of listeners.get(type) ?? []) fn()
    },
    emitClose() {
      for (const fn of listeners.get('close') ?? []) fn()
    },
  }
}

/** Install into a fresh window-ish object so tests do not share wrapped state. */
function freshWindow() {
  const created: ReturnType<typeof fakeSocket>[] = []
  const win = {
    WebSocket: function (this: unknown, url: string) {
      const socket = fakeSocket(url)
      created.push(socket)
      return socket
    },
  }
  return { win, created }
}

// Module globals (suspended, live, observers) are shared. The install flag is not.
beforeEach(() => {
  resetSocketLifecycleForTests()
})

describe('socket lifecycle', () => {
  it('tracks every socket the renderer opens', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    const a = new Socket('wss://gw.example/api/ws')
    const b = new Socket('wss://gw.example/api/ws?profile=work')
    void a
    void b
    expect(created).toHaveLength(2)
    expect(liveSocketCount()).toBe(2)
  })

  it('stops tracking a socket on close, but not on error (it may still be open)', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    const socket = new Socket('wss://gw.example/api/ws') as ReturnType<typeof fakeSocket>
    expect(liveSocketCount()).toBe(1)

    // An `error` frame does not mean the socket closed. Untracking it there
    // would leave an open socket the next background cannot reach.
    socket.emit('error')
    expect(liveSocketCount()).toBe(1)

    socket.emit('close')
    expect(liveSocketCount()).toBe(0)
    expect(created).toHaveLength(1)
  })

  it('closes the gateway socket when the app is backgrounded', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://gw.example/api/ws')
    new Socket('wss://gw.example/api/ws?profile=work')

    setSuspended(true)

    expect(isSuspended()).toBe(true)
    expect(liveSocketCount()).toBe(0)
    for (const socket of created) {
      expect(socket.closed).toHaveLength(1)
      expect(socket.closed[0]).toEqual({ code: 1000, reason: 'app backgrounded' })
      expect(socket.readyState).toBe(3)
    }
  })

  it('keeps a socket tracked when close rejects the code, and the next suspend finishes it', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://gw.example/api/ws')

    let thrown: unknown
    try {
      created[0].close(1001, 'app backgrounded')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).name).toBe('InvalidAccessError')
    expect(created[0].readyState).toBe(1)

    expect(closeGatewaySockets(1001, 'app backgrounded')).toBe(0)
    expect(liveSocketCount()).toBe(1)
    expect(isSuspended()).toBe(false)

    setSuspended(true)
    expect(created[0].readyState).toBe(3)
    expect(created[0].closed).toEqual([{ code: 1000, reason: 'app backgrounded' }])
    expect(liveSocketCount()).toBe(0)
  })

  it('retries a close that threw when suspension is re-asserted (the contract, not a plugin event)', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    const socket = new Socket('wss://gw.example/api/ws') as ReturnType<typeof fakeSocket>
    const realClose = socket.close.bind(socket)
    let failed = false
    socket.close = (code?: number, reason?: string) => {
      if (!failed) {
        failed = true
        const err = new Error('close failed')
        err.name = 'InvalidAccessError'
        throw err
      }
      realClose(code, reason)
    }

    setSuspended(true)
    expect(liveSocketCount()).toBe(1)
    expect(socket.readyState).toBe(1)

    setSuspended(true)
    expect(socket.readyState).toBe(3)
    expect(liveSocketCount()).toBe(0)
    expect(created).toHaveLength(1)
  })

  it('closes a socket the renderer opens while already suspended, and does not keep it', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    setSuspended(true)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://gw.example/api/ws?ticket=again')

    expect(created).toHaveLength(1)
    expect(created[0].readyState).toBe(3)
    expect(created[0].closed).toEqual([{ code: 1000, reason: 'app backgrounded' }])
    expect(liveSocketCount()).toBe(0)
    expect(isSuspended()).toBe(true)
  })

  it('closes a gateway socket that does not expose `url` (the wrapper knows the URL it was given)', () => {
    // `SocketLike.url` is optional, so a socket implementation that omits it
    // must not be read as "a sibling" — that skipped the close with no gap note
    // and no failing test (round 23 W1). The wrapper captured the URL itself.
    const closed: Array<{ code?: number; reason?: string }> = []
    const win = {
      WebSocket: function (this: unknown, _url: string) {
        return {
          readyState: 1,
          close(code?: number, reason?: string) {
            closed.push({ code, reason })
            this.readyState = 3
          },
          addEventListener() {
            /* no listeners needed for this case */
          },
        }
      },
    }
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown

    new Socket('wss://gw.example/api/ws?ticket=t')
    expect(liveSocketCount()).toBe(1)

    setSuspended(true)
    expect(closed).toEqual([{ code: 1000, reason: 'app backgrounded' }])
    expect(liveSocketCount()).toBe(0)
  })

  it('closes a url-less gateway socket constructed while already suspended (the constructor read)', () => {
    // The sibling of the case above, and a separate read: `closeGatewaySockets`
    // consults the registry, the constructor consults the URL it was handed. Only
    // this case fails when the constructor falls back to `socket.url` (round 24
    // W1 — the earlier test built its socket while visible, so it never entered
    // that branch).
    const closed: Array<{ code?: number; reason?: string }> = []
    const win = {
      WebSocket: function (this: unknown, _url: string) {
        return {
          readyState: 1,
          close(code?: number, reason?: string) {
            closed.push({ code, reason })
            this.readyState = 3
          },
          addEventListener() {
            /* no listeners needed for this case */
          },
        }
      },
    }
    installSocketLifecycle(win as never)
    setSuspended(true)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown

    new Socket('wss://gw.example/api/ws?ticket=t')

    expect(closed).toEqual([{ code: 1000, reason: 'app backgrounded' }])
    expect(liveSocketCount()).toBe(0)
  })

  it('hands observers the URL the wrapper captured, not the optional `socket.url`', () => {
    // One source of truth: the toast watch in `mobile-behaviors.tsx` scopes itself
    // by this value, so it must not depend on a field the close rule no longer
    // reads (round 24 S1).
    const seen: Array<{ url?: string; captured?: string }> = []
    onSocketCreated((socket, url) => seen.push({ captured: url, url: socket.url }))
    const win = {
      WebSocket: function (this: unknown, _url: string) {
        return { readyState: 1, close() {}, addEventListener() {} }
      },
    }
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown

    new Socket('wss://gw.example/api/ws?ticket=t')

    expect(seen).toEqual([{ captured: 'wss://gw.example/api/ws?ticket=t', url: undefined }])
  })

  it('leaves a sibling stream alone: only the gateway socket has a resume redial', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    const gateway = new Socket('wss://gw.example/api/ws?ticket=t') as ReturnType<typeof fakeSocket>
    // Bot Screen RFB and a plugin stream: their owners reconnect them, the
    // wrapper does not (the RFB pane parks on "stream lost" if we close it).
    const rfb = new Socket('wss://gw.example/api/display/ws?ticket=d') as ReturnType<typeof fakeSocket>
    const plugin = new Socket('wss://gw.example/api/plugins/bots/events?token=x') as ReturnType<typeof fakeSocket>

    setSuspended(true)

    expect(gateway.closed).toEqual([{ code: 1000, reason: 'app backgrounded' }])
    expect(rfb.closed).toHaveLength(0)
    expect(plugin.closed).toHaveLength(0)
    expect(rfb.readyState).toBe(1)
    expect(plugin.readyState).toBe(1)
    expect(created).toHaveLength(3)
    // Siblings stay tracked (their own close still untracks them).
    expect(liveSocketCount()).toBe(2)
  })

  it('leaves a sibling opened while already suspended open', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    setSuspended(true)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://gw.example/api/display/ws?ticket=d')
    new Socket('wss://gw.example/api/ws?ticket=t')

    expect(created).toHaveLength(2)
    expect(created[0].closed).toHaveLength(0) // sibling: its owner decides
    expect(created[0].readyState).toBe(1)
    expect(created[1].closed).toEqual([{ code: 1000, reason: 'app backgrounded' }])
    expect(liveSocketCount()).toBe(1)
  })

  it('does not close a resumed app\'s sockets and is idempotent on resume', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    setSuspended(true)
    setSuspended(false)
    setSuspended(false) // a second resume must not re-close anything
    new Socket('wss://gw.example/api/ws')
    expect(created[0].closed).toHaveLength(0)
    expect(liveSocketCount()).toBe(1)
  })

  it('forgets a socket that closed on its own (no unbounded growth)', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://gw.example/api/ws')
    expect(liveSocketCount()).toBe(1)
    created[0].emitClose()
    expect(liveSocketCount()).toBe(0)
  })

  it('tells observers about each new socket, and survives an observer throwing', () => {
    const { win } = freshWindow()
    installSocketLifecycle(win as never)
    const seen: unknown[] = []
    const bad = vi.fn(() => {
      throw new Error('observer exploded')
    })
    onSocketCreated(bad)
    onSocketCreated((socket) => seen.push(socket))
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://gw.example/api/ws')
    expect(bad).toHaveBeenCalledTimes(1)
    expect(seen).toHaveLength(1)
  })

  it('does not keep an observer registered by a previous test', () => {
    const seen: unknown[] = []
    onSocketCreated(() => seen.push(1))
    resetSocketLifecycleForTests()
    const { win } = freshWindow()
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://gw.example/api/ws')
    expect(seen).toHaveLength(0)
  })

  it('wraps exactly once, even if install runs again', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    const first = win.WebSocket
    installSocketLifecycle(win as never)
    expect(win.WebSocket).toBe(first)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://gw.example/api/ws')
    expect(created).toHaveLength(1)
  })

  it('does not claim to be installed when there is no WebSocket constructor (HM-32 review)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const win: { WebSocket?: unknown; __hermesSocketLifecycleInstalled?: boolean } = {}

    installSocketLifecycle(win as never)

    expect(isSocketLifecycleInstalled(win)).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)

    // A second install on the same empty window must not spam the log.
    installSocketLifecycle(win as never)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('marks the window installed once the wrapper is really in place', () => {
    const { win } = freshWindow()
    installSocketLifecycle(win as never)
    expect(isSocketLifecycleInstalled(win)).toBe(true)
  })
})
