import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  closeAllSockets,
  installSocketLifecycle,
  isSocketLifecycleInstalled,
  isSuspended,
  liveSocketCount,
  onSocketCreated,
  resetSocketLifecycleForTests,
  setSuspended,
} from './socket-lifecycle'

/** A stand-in for a real WebSocket: records close calls, fires listeners.
 *  Rejects a code Chromium would reject, so a suite cannot go green on 1001. */
function fakeSocket() {
  const listeners = new Map<string, Array<() => void>>()
  const closed: Array<{ code?: number; reason?: string }> = []
  return {
    readyState: 1,
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
    emitClose() {
      for (const fn of listeners.get('close') ?? []) fn()
    },
  }
}

/** Install into a fresh window-ish object so tests do not share wrapped state. */
function freshWindow() {
  const created: ReturnType<typeof fakeSocket>[] = []
  const win = {
    WebSocket: function (this: unknown) {
      const socket = fakeSocket()
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
    const a = new Socket('wss://example/a')
    const b = new Socket('wss://example/b')
    void a
    void b
    expect(created).toHaveLength(2)
    expect(liveSocketCount()).toBe(2)
  })

  it('closes every tracked socket when the app is backgrounded', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://example/a')
    new Socket('wss://example/b')

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
    new Socket('wss://example/a')

    let thrown: unknown
    try {
      created[0].close(1001, 'app backgrounded')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).name).toBe('InvalidAccessError')
    expect(created[0].readyState).toBe(1)

    expect(closeAllSockets(1001, 'app backgrounded')).toBe(0)
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
    const socket = new Socket('wss://example/a') as ReturnType<typeof fakeSocket>
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
    new Socket('wss://example/again')

    expect(created).toHaveLength(1)
    expect(created[0].readyState).toBe(3)
    expect(created[0].closed).toEqual([{ code: 1000, reason: 'app backgrounded' }])
    expect(liveSocketCount()).toBe(0)
    expect(isSuspended()).toBe(true)
  })

  it('does not close a resumed app\'s sockets and is idempotent on resume', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    setSuspended(true)
    setSuspended(false)
    setSuspended(false) // a second resume must not re-close anything
    new Socket('wss://example/a')
    expect(created[0].closed).toHaveLength(0)
    expect(liveSocketCount()).toBe(1)
  })

  it('forgets a socket that closed on its own (no unbounded growth)', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://example/a')
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
    new Socket('wss://example/a')
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
    new Socket('wss://example/a')
    expect(seen).toHaveLength(0)
  })

  it('wraps exactly once, even if install runs again', () => {
    const { win, created } = freshWindow()
    installSocketLifecycle(win as never)
    const first = win.WebSocket
    installSocketLifecycle(win as never)
    expect(win.WebSocket).toBe(first)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://example/a')
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
