import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  describeFrame,
  instrumentWebSocket,
  installRpcTrace,
  RpcTrace,
  rpcTrace,
  safeRestPath,
  TRACE_CAPACITY,
  traceEnabled,
} from './rpc-trace'
import { installSocketLifecycle, resetSocketLifecycleForTests } from './socket-lifecycle'

/** A minimal WebSocket double: records sends, lets a test push inbound frames. */
function fakeSocket() {
  const listeners: Record<string, Array<(event: { data?: unknown }) => void>> = {}
  const sent: unknown[] = []
  return {
    sent,
    send(data: unknown) {
      sent.push(data)
    },
    addEventListener(type: string, cb: (event: { data?: unknown }) => void) {
      ;(listeners[type] ??= []).push(cb)
    },
    emit(type: string, event: { data?: unknown }) {
      for (const cb of listeners[type] ?? []) cb(event)
    },
  }
}

const request = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params })

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('describeFrame', () => {
  it('reads a request method name (and id) without touching params', () => {
    const d = describeFrame(request(7, 'groups.send', { room_id: 'r1', text: 'hi' }))
    expect(d).toEqual({ kind: 'request', name: 'groups.send', id: 7 })
  })

  it('names a server push from params.type', () => {
    const d = describeFrame(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'sessions.changed' } }))
    expect(d).toEqual({ kind: 'event', name: 'event:sessions.changed' })
  })

  it('classifies a result response as ok and an error response as failed', () => {
    expect(describeFrame(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))).toMatchObject({
      kind: 'response',
      ok: true,
    })
    expect(describeFrame(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32601 } }))).toMatchObject({
      kind: 'response',
      ok: false,
    })
  })

  it('degrades to a plain frame for junk, scalars and oversized text', () => {
    expect(describeFrame('not json')).toEqual({ kind: 'frame', name: 'frame' })
    expect(describeFrame('42')).toEqual({ kind: 'frame', name: 'frame' })
    expect(describeFrame('x'.repeat(32), 8)).toEqual({ kind: 'frame', name: 'frame' })
  })
})

describe('RpcTrace', () => {
  it('caps the ring buffer at capacity and counts dropped entries', () => {
    const trace = new RpcTrace(3)
    for (let i = 0; i < 5; i++) trace.record({ dir: 'out', name: `m${i}` })
    expect(trace.size).toBe(3)
    expect(trace.dropped).toBe(2)
    expect(trace.snapshot().map((e) => e.name)).toEqual(['m2', 'm3', 'm4'])
  })

  it('is inert when disabled', () => {
    const trace = new RpcTrace(TRACE_CAPACITY, false)
    trace.record({ dir: 'out', name: 'groups.send' })
    expect(trace.size).toBe(0)
    expect(trace.toText()).not.toContain('groups.send')
  })

  it('exports one line per entry with ms and ok', () => {
    const trace = new RpcTrace(10, true, () => 1_000)
    trace.record({ dir: 'out', name: 'groups.send' })
    trace.record({ dir: 'in', name: 'groups.send', ms: 42, ok: true })
    const text = trace.toText({ app: '0.1.1' })
    expect(text).toContain('# app: 0.1.1')
    expect(text).toMatch(/out\s+groups\.send/)
    expect(text).toMatch(/in\s+groups\.send\s+42ms ok/)
  })
})

describe('instrumentWebSocket — the guard that params never reach the trace', () => {
  it('stores method + event NAMES only, never params, headers or ids', () => {
    const trace = new RpcTrace()
    const ws = fakeSocket()
    instrumentWebSocket(ws, trace, () => 5_000)

    const SECRET = 'sk-live-do-not-log-9f8e7d6c5b4a'
    const COOKIE = 'session=abc123def456'
    ws.send(request(1, 'groups.send', { text: 'hello', nested: { token: SECRET }, cookie: COOKIE }))
    ws.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { echoed: SECRET } }) })
    ws.emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'sessions.changed', payload: SECRET } }),
    })

    const dump = JSON.stringify(trace.snapshot())
    const text = trace.toText()
    for (const secret of [SECRET, COOKIE, 'sk-live', 'session=', 'nested', 'echoed']) {
      expect(dump).not.toContain(secret)
      expect(text).not.toContain(secret)
    }
    // …while the useful names are present.
    expect(dump).toContain('groups.send')
    expect(text).toContain('event:sessions.changed')
  })

  it('pairs a response with its request to time the round-trip', () => {
    let clock = 100
    const trace = new RpcTrace(10, true, () => clock)
    const ws = fakeSocket()
    instrumentWebSocket(ws, trace, () => clock)

    ws.send(request(1, 'session.list', {}))
    clock += 37 // the round trip must be measured, not asserted away
    ws.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }) })

    const [out, back] = trace.snapshot()
    expect(out).toMatchObject({ dir: 'out', name: 'session.list' })
    expect(out.ms).toBeUndefined()
    expect(back).toMatchObject({ dir: 'in', name: 'session.list', ok: true, ms: 37 })
  })

  it('forgets in-flight ids when the socket closes (no unbounded growth)', () => {
    const trace = new RpcTrace()
    const ws = fakeSocket()
    instrumentWebSocket(ws, trace)
    for (let i = 0; i < 5; i++) ws.send(request(i, 'session.list', {}))
    ws.emit('close', {})
    // A response for an id sent before the close must not be paired any more.
    ws.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: 0, result: [] }) })
    const back = trace.snapshot().filter((e) => e.dir === 'in')
    // Pin the shape first: `[].every(...)` is true, so without this the test
    // passed even if inbound frames stopped being recorded at all. Round-2 finding.
    expect(back.length).toBe(1)
    expect(back.every((e) => e.ms === undefined)).toBe(true)
  })

  it('passes frames through untouched', () => {
    const trace = new RpcTrace()
    const ws = fakeSocket()
    instrumentWebSocket(ws, trace)
    const frame = request(1, 'groups.send', { text: 'hi' })
    ws.send(frame)
    expect(ws.sent).toEqual([frame])
  })
})

describe('safeRestPath', () => {
  it('drops the query string (which can carry a ticket) and the fragment', () => {
    expect(safeRestPath('/api/ws?ticket=abc&x=1')).toBe('/api/ws')
    expect(safeRestPath('/api/x#frag')).toBe('/api/x')
    expect(safeRestPath('')).toBe('/')
  })
})

describe('installRpcTrace', () => {
  it('wraps WebSocket, publishes the debug global, and is idempotent', () => {
    const Original = class {
      constructor(public url: string) {}
      send(): void {}
      addEventListener(): void {}
    }
    const win = { WebSocket: Original as unknown as never } as never as Parameters<typeof installRpcTrace>[0] & {
      WebSocket: unknown
    }
    const first = installRpcTrace(win)
    expect(first).not.toBeNull()
    expect((win as { __hermesRpcTrace?: { size: () => number } }).__hermesRpcTrace?.size()).toBe(0)
    const Wrapped = (win as { WebSocket: unknown }).WebSocket
    expect(Wrapped).not.toBe(Original)
    installRpcTrace(win)
    expect((win as { WebSocket: unknown }).WebSocket).toBe(Wrapped)
  })

  it('is a no-op when the build disables the trace', () => {
    vi.stubEnv('VITE_HERMES_TRACE', 'false')
    expect(traceEnabled()).toBe(false)
    const win = {} as never as Parameters<typeof installRpcTrace>[0] & { WebSocket: unknown }
    expect(installRpcTrace(win)).toBeNull()
    expect((win as { __hermesRpcTrace?: unknown }).__hermesRpcTrace).toBeUndefined()
  })
})

describe('installRpcTrace on top of the socket lifecycle', () => {
  /** A window whose WebSocket constructor hands out the trace fake sockets. */
  function lifecycleWindow() {
    const created: Array<ReturnType<typeof fakeSocket>> = []
    const win = {
      WebSocket: function (this: unknown) {
        const socket = fakeSocket()
        created.push(socket)
        return socket
      },
    }
    return { win, created }
  }

  const dirs = () => rpcTrace.snapshot().map((e) => `${e.dir}:${e.name}`)

  it('instruments through the observer: exactly one out and one in per call', () => {
    resetSocketLifecycleForTests()
    rpcTrace.clear()
    const { win, created } = lifecycleWindow()
    installSocketLifecycle(win as never)
    installRpcTrace(win as never)

    // The shipping path: the lifecycle wrapper builds the socket, the trace
    // never wraps WebSocket a second time.
    const Socket = win.WebSocket as unknown as new (u: string) => ReturnType<typeof fakeSocket>
    const ws = new Socket('wss://gw:9119/api/ws')
    expect(created).toHaveLength(1)

    ws.send(request(11, 'groups.send', { text: 'hi' }))
    ws.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: 11, result: {} }) })

    expect(dirs()).toEqual(['out:groups.send', 'in:groups.send'])
    expect(rpcTrace.snapshot()[1]?.ms).toBeTypeOf('number')
  })

  it('does not double-record when installRpcTrace runs again for another window', () => {
    resetSocketLifecycleForTests()
    rpcTrace.clear()
    const first = lifecycleWindow()
    installSocketLifecycle(first.win as never)
    installRpcTrace(first.win as never)

    const second = lifecycleWindow()
    installSocketLifecycle(second.win as never)
    installRpcTrace(second.win as never)

    const Socket = second.win.WebSocket as unknown as new (u: string) => ReturnType<typeof fakeSocket>
    const ws = new Socket('wss://gw:9119/api/ws')
    ws.send(request(12, 'sessions.list', {}))

    expect(dirs()).toEqual(['out:sessions.list'])
  })

  it('never instruments one socket twice, however many paths reach it', () => {
    resetSocketLifecycleForTests()
    const trace = new RpcTrace()
    const ws = fakeSocket()
    instrumentWebSocket(ws, trace)
    instrumentWebSocket(ws, trace)

    ws.send(request(13, 'ping', {}))
    expect(trace.snapshot().map((e) => e.dir)).toEqual(['out'])
  })
})
