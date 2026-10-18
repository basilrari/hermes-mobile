/**
 * rpc-trace.ts — debug-only RPC trace.
 *
 * Records METADATA ONLY: timestamp, direction, the JSON-RPC method name (or
 * `event:<type>` for a server push), round-trip ms, and ok/failed. It never
 * records params, bodies, headers, cookies, tickets, tokens or query strings —
 * `rpc-trace.test.ts` asserts a secret planted in a frame's params cannot reach
 * an entry or the exported text.
 *
 * Purpose (HM-05): prove the app speaks gateway RPC only and never calls
 * `bot_relay.*`, and see which server pushes arrive (`sessions.changed`, …).
 * The headless harness reads `window.__hermesRpcTrace`; on the tablet a
 * long-press on the version badge shares the same text (TraceBadge.tsx).
 *
 * Enabled by default. `VITE_HERMES_TRACE=false` leaves the whole module inert
 * (no buffer, no WebSocket wrap, no global); that is the documented release knob,
 * and nothing in this repo sets it, so a plain `vite build` ships the trace. The
 * socket-lifecycle control must therefore work whether or not the trace is on.
 */

import { onLifecycleGap } from './lifecycle-gap'
import { isSocketLifecycleInstalled, onSocketCreated, type SocketLike } from './socket-lifecycle'

export type TraceDirection = 'in' | 'out' | 'rest'

export interface TraceEntry {
  /** Epoch milliseconds. */
  t: number
  dir: TraceDirection
  /** JSON-RPC method, `event:<type>`, `response`, or `<METHOD> <path>`. */
  name: string
  /** Round-trip time, for an out request paired with its in response. */
  ms?: number
  /** REST + responses: did it succeed. */
  ok?: boolean
}

/** Ring-buffer size (HM-05: last 2,000 entries). */
export const TRACE_CAPACITY = 2000

/**
 * Frames larger than this are not JSON-parsed for a method name. Tool-delta /
 * reasoning streams can be big and parsing every one would cost more than the
 * trace is worth; they are recorded as an unparsed frame instead.
 */
export const TRACE_MAX_PARSE_BYTES = 262_144

/** Is the trace enabled for this build? Off only when explicitly disabled. */
export function traceEnabled(): boolean {
  return import.meta.env.VITE_HERMES_TRACE !== 'false'
}

export interface FrameDescriptor {
  kind: 'request' | 'response' | 'event' | 'frame'
  /** Method name, or `event:<type>`. `frame` for anything unparsed. */
  name: string
  /** JSON-RPC id, when present (used to pair a response with its request). */
  id?: string | number
  /** Responses only: whether the frame carried no `error`. */
  ok?: boolean
}

const decoder = new TextDecoder()

/** Decode a socket frame (string / ArrayBuffer / view) to text; null otherwise. */
export function frameText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (raw instanceof ArrayBuffer) return decoder.decode(raw)
  if (ArrayBuffer.isView(raw)) return decoder.decode(raw as ArrayBufferView as ArrayBufferView)
  return null
}

/**
 * Describe ONE JSON-RPC frame, extracting only the method/event NAME. Params,
 * results and errors are never read past the type tag, so no payload can leak
 * into an entry.
 */
export function describeFrame(text: string, maxBytes = TRACE_MAX_PARSE_BYTES): FrameDescriptor | null {
  if (!text || text.length > maxBytes) return { kind: 'frame', name: 'frame' }
  let frame: unknown
  try {
    frame = JSON.parse(text)
  } catch {
    return { kind: 'frame', name: 'frame' }
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return { kind: 'frame', name: 'frame' }

  const obj = frame as Record<string, unknown>
  const id = typeof obj.id === 'string' || typeof obj.id === 'number' ? obj.id : undefined

  if (typeof obj.method === 'string') {
    if (obj.method === 'event') {
      const params = obj.params && typeof obj.params === 'object' ? (obj.params as Record<string, unknown>) : null
      const type = params && typeof params.type === 'string' ? params.type : null
      return { kind: 'event', name: type ? `event:${type}` : 'event' }
    }
    // An outgoing request OR an inbound server->client request (clarify, …).
    return { kind: 'request', name: obj.method, id }
  }

  if (id !== undefined) {
    return { kind: 'response', name: 'response', id, ok: !('error' in obj) }
  }

  return { kind: 'frame', name: 'frame' }
}

/** The recorded shape of a frame name. Clamped so a hostile name cannot bloat a buffer. */
function safeName(name: string): string {
  const trimmed = name.length > 120 ? `${name.slice(0, 117)}...` : name
  return trimmed.replace(/[\r\n\t]/g, ' ')
}

/** Strip a query string (may carry `?token=`/`?ticket=`) and any userinfo. */
export function safeRestPath(path: string): string {
  const noQuery = path.split(/[?#]/, 1)[0] ?? path
  // The doc line above promises userinfo is gone, so reduce an absolute (or
  // protocol-relative) URL to its path: `https://user:tok@host/api/x` must record
  // `/api/x`, or the credential lands in the badge's share text. Callers normally
  // pass a relative path, but `rawRequest({path})` is exported and `api()` forwards
  // it verbatim when no profile scope is set.
  const noOrigin = noQuery.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*/i, '')
  return safeName(noOrigin || '/')
}

export class RpcTrace {
  private buffer: TraceEntry[] = []
  private droppedCount = 0

  constructor(
    private readonly capacity: number = TRACE_CAPACITY,
    private readonly enabled: boolean = true,
    private readonly now: () => number = Date.now,
  ) {}

  record(entry: { dir: TraceDirection; name: string; ms?: number; ok?: boolean }): void {
    if (!this.enabled) return
    const stored: TraceEntry = { t: this.now(), dir: entry.dir, name: safeName(entry.name) }
    if (entry.ms !== undefined) stored.ms = Math.max(0, Math.round(entry.ms))
    if (entry.ok !== undefined) stored.ok = entry.ok
    this.buffer.push(stored)
    if (this.buffer.length > this.capacity) {
      this.droppedCount += this.buffer.length - this.capacity
      this.buffer.splice(0, this.buffer.length - this.capacity)
    }
  }

  snapshot(): TraceEntry[] {
    return this.buffer.map((e) => ({ ...e }))
  }

  clear(): void {
    this.buffer = []
    this.droppedCount = 0
  }

  get size(): number {
    return this.buffer.length
  }

  get dropped(): number {
    return this.droppedCount
  }

  /** Plain-text export: one line per entry. Safe to attach to an issue. */
  toText(meta: Record<string, string | number> = {}): string {
    const lines = [`# hermes-mobile RPC trace`]
    for (const [k, v] of Object.entries(meta)) lines.push(`# ${k}: ${v}`)
    lines.push(`# entries: ${this.buffer.length} (capacity ${this.capacity}, dropped ${this.droppedCount})`)
    for (const e of this.buffer) {
      const iso = new Date(e.t).toISOString()
      const tail = [e.ms !== undefined ? `${e.ms}ms` : '', e.ok === undefined ? '' : e.ok ? 'ok' : 'FAIL']
        .filter(Boolean)
        .join(' ')
      lines.push(`${iso} ${e.dir.padEnd(4)} ${e.name}${tail ? `  ${tail}` : ''}`)
    }
    return lines.join('\n')
  }
}

/* ------------------------------------------------------------------ *
 * WebSocket instrumentation
 * ------------------------------------------------------------------ */

/** The slice of WebSocket the tracer needs; a fake satisfies it in tests. */
export interface WebSocketLike {
  send(data: unknown): void
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
}

/**
 * Instrument ONE socket: every outbound frame's method name, every inbound
 * frame's response/event name, and the ms between a request and its response.
 * Only names leave this function — params are never read.
 */
export function instrumentWebSocket(ws: WebSocketLike, trace: RpcTrace, now: () => number = Date.now): void {
  // Two paths can reach the same socket (the WebSocket wrapper, and the
  // socket-lifecycle observer). A second instrument would bind the ALREADY
  // wrapped `send` and record every frame through both, so mark the socket.
  // (`__hermesTraced` on the CONSTRUCTOR is installRpcTrace's own wrap guard —
  // this marker is per socket, not per window.)
  const marked = ws as unknown as { __hermesSocketTraced?: boolean }
  if (marked.__hermesSocketTraced) return

  const pending = new Map<string | number, { name: string; t: number }>()
  const originalSend = ws.send.bind(ws)

  ws.send = (data: unknown): void => {
    const text = frameText(data)
    if (text) {
      const d = describeFrame(text)
      if (d?.kind === 'request' && d.id !== undefined) {
        pending.set(d.id, { name: d.name, t: now() })
        trace.record({ dir: 'out', name: d.name })
      } else if (d) {
        trace.record({ dir: 'out', name: d.name })
      }
    }
    originalSend(data)
  }
  // Set before the listeners: `send` is what would double-record, and a throw
  // from `addEventListener` below must not leave it looking un-instrumented.
  marked.__hermesSocketTraced = true

  ws.addEventListener('message', (event) => {
    const text = frameText(event?.data)
    if (!text) return
    const d = describeFrame(text)
    if (!d) {
      trace.record({ dir: 'in', name: 'frame' })
      return
    }
    if (d.kind === 'response' && d.id !== undefined) {
      const call = pending.get(d.id)
      if (call) {
        pending.delete(d.id)
        trace.record({ dir: 'in', name: call.name, ms: now() - call.t, ok: d.ok })
        return
      }
    }
    trace.record({ dir: 'in', name: d.name, ok: d.kind === 'response' ? d.ok : undefined })
  })

  // A socket that closes with calls in flight would otherwise keep every
  // unanswered id for the lifetime of the process. Round-1 finding.
  const forgetInFlight = (): void => pending.clear()
  ws.addEventListener('close', forgetInFlight)
  ws.addEventListener('error', forgetInFlight)
}

/* ------------------------------------------------------------------ *
 * Installation
 * ------------------------------------------------------------------ */

/** Process-wide trace the bridge (REST) and the wrapped sockets both write to. */
export const rpcTrace = new RpcTrace(TRACE_CAPACITY, traceEnabled())

export interface TraceGlobal {
  snapshot(): TraceEntry[]
  toText(meta?: Record<string, string | number>): string
  clear(): void
  size(): number
}

interface TraceWindow {
  WebSocket?: TraceableWebSocket
  __hermesRpcTrace?: TraceGlobal
  __hermesRpcTraceInstalled?: boolean
}

interface TraceableWebSocket {
  (url: string, protocols?: string | string[]): WebSocketLike
  prototype: unknown
  CONNECTING?: number
  OPEN?: number
  CLOSING?: number
  CLOSED?: number
}

/**
 * Stable observer reference. `observers` is a Set, so registering this function
 * twice is a no-op — a repeated install cannot double-instrument a socket.
 */
const instrumentObserver = (socket: SocketLike): void => {
  try {
    instrumentWebSocket(socket as unknown as WebSocketLike, rpcTrace)
  } catch {
    /* tracing must never break the app */
  }
}

/**
 * Wrap `globalThis.WebSocket` so every socket the vendored renderer opens is
 * traced, and publish `window.__hermesRpcTrace`. Idempotent. No-op when the
 * trace is disabled. Must run before any socket is created (boot.ts).
 */
export function installRpcTrace(win: TraceWindow = globalThis as unknown as TraceWindow): RpcTrace | null {
  if (!traceEnabled()) return null
  if (win.__hermesRpcTraceInstalled) return rpcTrace

  // The socket-lifecycle module wraps WebSocket unconditionally (it has to work
  // when tracing is off), so when it is installed we instrument through its
  // observer hook instead of wrapping a second time: a second wrapper would put
  // two instrumenters on one socket, and the trace would record every frame
  // twice. (Wrapping twice around ONLY the trace wrapper is harmless — that
  // was the earlier claim here, and it was wrong about the hazard.) Round: HM-32.
  const Original = win.WebSocket
  if (isSocketLifecycleInstalled(win)) {
    onSocketCreated(instrumentObserver)
  } else if (typeof Original === 'function' && !(Original as { __hermesTraced?: boolean }).__hermesTraced) {
    const Wrapped = function (this: unknown, url: string, protocols?: string | string[]): WebSocketLike {
      const socket =
        protocols === undefined
          ? new (Original as unknown as new (u: string) => WebSocketLike)(url)
          : new (Original as unknown as new (u: string, p: string | string[]) => WebSocketLike)(url, protocols)
      try {
        instrumentWebSocket(socket, rpcTrace)
      } catch {
        /* tracing must never break the app */
      }
      return socket
    } as TraceableWebSocket
    Wrapped.prototype = Original.prototype
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
      if (Original[key] !== undefined) Wrapped[key] = Original[key]
    }
    ;(Wrapped as { __hermesTraced?: boolean }).__hermesTraced = true
    win.WebSocket = Wrapped
  }

  win.__hermesRpcTrace = {
    snapshot: () => rpcTrace.snapshot(),
    toText: (meta) => rpcTrace.toText(meta),
    clear: () => rpcTrace.clear(),
    size: () => rpcTrace.size,
  }
  // A control that could not install itself leaves no other trace of the fact
  // (lifecycle-gap.ts). The note is metadata only, like every other entry, and
  // it is readable on-device where `console.*` is not on a release build.
  onLifecycleGap((message) => rpcTrace.record({ dir: 'rest', name: `lifecycle: ${message}`, ok: false }))

  win.__hermesRpcTraceInstalled = true
  return rpcTrace
}
