import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  closeAllSockets,
  installSocketLifecycle,
  isSuspended,
  liveSocketCount,
  onSocketCreated,
  setSuspended,
} from './socket-lifecycle'

/** A stand-in for a real WebSocket: records close calls, fires listeners. */
function fakeSocket() {
  const listeners = new Map<string, Array<() => void>>()
  const closed: Array<{ code?: number; reason?: string }> = []
  return {
    readyState: 1,
    closed,
    close(code?: number, reason?: string) {
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
function freshWindow(sockets: ReturnType<typeof fakeSocket>[]) {
  const created: ReturnType<typeof fakeSocket>[] = []
  const win = {
    WebSocket: function (this: unknown, url: string) {
      void url
      const socket = fakeSocket()
      created.push(socket)
      return socket
    },
    sockets,
  }
  return { win, created }
}

// Every test starts from a known suspension state.
beforeEach(() => {
  setSuspended(false)
  closeAllSockets()
})

describe('socket lifecycle', () => {
  it('tracks every socket the renderer opens', () => {
    const { win, created } = freshWindow([])
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
    const { win, created } = freshWindow([])
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://example/a')
    new Socket('wss://example/b')

    setSuspended(true)

    expect(isSuspended()).toBe(true)
    expect(liveSocketCount()).toBe(0)
    for (const socket of created) {
      expect(socket.closed).toHaveLength(1)
      expect(socket.closed[0]).toEqual({ code: 1001, reason: 'app backgrounded' })
      expect(socket.readyState).toBe(3)
    }
  })

  it('does not close a resumed app\'s sockets and is idempotent on resume', () => {
    const { win, created } = freshWindow([])
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
    const { win, created } = freshWindow([])
    installSocketLifecycle(win as never)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://example/a')
    expect(liveSocketCount()).toBe(1)
    created[0].emitClose()
    expect(liveSocketCount()).toBe(0)
  })

  it('tells observers about each new socket, and survives an observer throwing', () => {
    const { win } = freshWindow([])
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

  it('wraps exactly once, even if install runs again', () => {
    const { win, created } = freshWindow([])
    installSocketLifecycle(win as never)
    const first = win.WebSocket
    installSocketLifecycle(win as never)
    expect(win.WebSocket).toBe(first)
    const Socket = win.WebSocket as unknown as new (u: string) => unknown
    new Socket('wss://example/a')
    expect(created).toHaveLength(1)
  })
})
