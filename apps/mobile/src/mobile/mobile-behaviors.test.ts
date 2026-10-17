// @vitest-environment jsdom
/**
 * The suspend flag is a module global, and this component is its only writer
 * (HM-32 review round 6). The auth path unmounts the component while the app is
 * hidden: `api()` calls `requireReauth()` on a 401 (`http.ts`), `app.tsx`
 * leaves the connected tree, and `AppPlugin` notifies `appStateChange` with
 * `retain = false`, so the listener registered by the next mount never sees
 * `isActive: true`. A flag that outlived that unmount would leave every dial on
 * a visible app throwing `GatewayDialSuppressed` until a reload.
 *
 * jsdom and `@testing-library/react` are declared by `apps/desktop` and hoisted
 * to the workspace root, where this package resolves them; no new dependency.
 */
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted: the vi.mock factories run before ordinary bindings exist.
const { listeners } = vi.hoisted(() => ({
  listeners: [] as { event: string; cb: (payload: { isActive: boolean }) => void }[],
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((event: string, cb: (payload: { isActive: boolean }) => void) => {
      listeners.push({ event, cb })
      return Promise.resolve({ remove: () => {} })
    }),
    exitApp: vi.fn(),
  },
}))

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn(() => Promise.resolve({ remove: () => {} })),
    hide: vi.fn(),
  },
}))

import { installSocketLifecycle, isSuspended, resetSocketLifecycleForTests, setSuspended } from '~bridge/socket-lifecycle'
import { translateNow } from '@/i18n'
import { $notifications, notify } from '@/store/notifications'

import { MobileBehaviors } from './mobile-behaviors'

/** The `appStateChange` callback of the most recent mount. */
function appState(): (payload: { isActive: boolean }) => void {
  const last = listeners.filter((l) => l.event === 'appStateChange').at(-1)
  if (!last) throw new Error('no appStateChange listener registered')
  return last.cb
}

function mount() {
  return render(createElement(MemoryRouter, null, createElement(MobileBehaviors)))
}

/** The gateway RPC route (`connection-config.ts` builders) — the only socket
 *  whose `open` is evidence about the gateway connection. */
const GATEWAY_URL = 'wss://gw.example/api/ws?ticket=t'

/** A window whose WebSocket records itself (and the URL it was built with) and
 *  can fire `open`/`close`. */
function lifecycleWindow() {
  const created: { fire: (type: string) => void; url: string }[] = []
  const win = {
    WebSocket: function (url: string) {
      const handlers = new Map<string, Array<() => void>>()
      const socket = {
        url,
        readyState: 1,
        close() {
          socket.readyState = 3
          socket.fire('close')
        },
        addEventListener(type: string, fn: () => void) {
          handlers.set(type, [...(handlers.get(type) ?? []), fn])
        },
        removeEventListener(type: string, fn: () => void) {
          handlers.set(type, (handlers.get(type) ?? []).filter((f) => f !== fn))
        },
        fire(type: string) {
          for (const fn of handlers.get(type) ?? []) fn()
        },
      }
      created.push(socket)
      return socket
    },
  }
  return { win, created }
}

/**
 * The sticky escalation toast the boot hook raises while the ladder fails
 * (`use-gateway-boot.ts:597-608`), raised through the real store so the test also
 * pins what `notify()` does to `createdAt` — a fabricated alert hid that contract
 * (round 8).
 */
function raiseLossAlert(): string {
  return notify({
    kind: 'warning',
    title: translateNow('boot.errors.gatewayConnectionLost'),
    message: translateNow('boot.errors.gatewayConnectionLostDetail'),
    durationMs: 0,
  })
}

beforeEach(() => {
  resetSocketLifecycleForTests()
  listeners.length = 0
  $notifications.set([])
})

afterEach(() => {
  cleanup()
  resetSocketLifecycleForTests()
  $notifications.set([])
})

describe('MobileBehaviors owns the suspend flag (HM-32)', () => {
  it('does not inherit a stuck gate: mounting clears the flag', () => {
    setSuspended(true)
    expect(isSuspended()).toBe(true)

    const view = mount()

    expect(isSuspended()).toBe(false)
    view.unmount()
  })

  it('leaves the gate closed when it unmounts while hidden, and the next mount opens it', () => {
    const view = mount()

    act(() => appState()({ isActive: false }))
    expect(isSuspended()).toBe(true)

    // The 401 path: the component goes away while the app is still hidden. The
    // gate must STAY closed — the resolver outlives this component, and a dial in
    // that window would mint a ticket behind a screen nobody is looking at
    // (round 14).
    view.unmount()
    expect(isSuspended()).toBe(true)

    // Next login remounts. The plugin does not replay `isActive: true`, so this
    // mount is the only thing that can open the gate again — and it does.
    const again = mount()
    expect(isSuspended()).toBe(false)

    act(() => appState()({ isActive: false }))
    expect(isSuspended()).toBe(true)
    again.unmount()
    expect(isSuspended()).toBe(true)
  })
})

describe('the connection-lost toast is dismissed only on recovery (HM-32)', () => {
  it('keeps the alert on resume when the gateway is still down', () => {
    const view = mount()
    act(() => appState()({ isActive: false }))

    // The escalation fires while hidden (300 s of suppressed ladder steps) and
    // the gateway is genuinely dead, so nothing opens on resume.
    const id = raiseLossAlert()

    act(() => appState()({ isActive: true }))

    // Coming back on screen is not evidence of recovery: the toast is the only
    // actionable thing the user has, and the next escalation is ~300 s away.
    expect($notifications.get().map((n) => n.id)).toEqual([id])
    view.unmount()
  })

  it('dismisses the alert once a socket opens', () => {
    const { win, created } = lifecycleWindow()
    installSocketLifecycle(win as never)
    const view = mount()
    act(() => appState()({ isActive: false }))
    raiseLossAlert()

    // The post-resume dial succeeds: an open socket is proof, not a proxy.
    const Socket = win.WebSocket as unknown as new (url: string) => { fire: (t: string) => void }
    const socket = new Socket(GATEWAY_URL)
    expect(created).toHaveLength(1)
    act(() => socket.fire('open'))

    expect($notifications.get()).toEqual([])
    view.unmount()
  })

  it('does not treat a sibling socket opening as gateway recovery', () => {
    const { win } = lifecycleWindow()
    installSocketLifecycle(win as never)
    const view = mount()
    act(() => appState()({ isActive: false }))
    const id = raiseLossAlert()

    // Plugin streams, dictation and Bot Screen RFB all open on their own paths
    // beside the gateway (`isGatewayWsUrl`). The observer watches every wrapped
    // socket, so an `open` that is not the gateway must not spend the window.
    const Socket = win.WebSocket as unknown as new (url: string) => { fire: (t: string) => void }
    act(() => new Socket('wss://gw.example/api/audio/transcribe-stream?token=t').fire('open'))
    act(() => new Socket('wss://gw.example/api/plugins/kanban/events?token=t').fire('open'))
    expect($notifications.get().map((n) => n.id)).toEqual([id])

    // The window is intact: the gateway opening still clears it.
    act(() => new Socket(GATEWAY_URL).fire('open'))
    expect($notifications.get()).toEqual([])
    view.unmount()
  })

  it('stops watching a socket it saw when it unmounts, so a dead mount cannot dismiss (round 26 S2)', () => {
    const { win } = lifecycleWindow()
    installSocketLifecycle(win as never)
    const view = mount()
    act(() => appState()({ isActive: false }))
    const Socket = win.WebSocket as unknown as new (url: string) => { fire: (t: string) => void }
    // The observer binds this socket's `open` while the window is open.
    const socket = new Socket(GATEWAY_URL)

    // The 401 path: the component goes away while hidden, and the socket it saw
    // can still be open — `removeOpenWatch()` only drops the observer, not the
    // listener already attached to this socket. A late `open` must not run the
    // dead mount's dismissal: the toast below was raised after it left.
    view.unmount()
    const id = raiseLossAlert()
    act(() => socket.fire('open'))

    expect($notifications.get().map((n) => n.id)).toEqual([id])
  })

  it('leaves a toast raised on a visible app alone once the window is spent', () => {
    const { win } = lifecycleWindow()
    installSocketLifecycle(win as never)
    const view = mount()
    const Socket = win.WebSocket as unknown as new (url: string) => { fire: (t: string) => void }

    // First hidden window: the escalation fires while hidden, then the connection
    // recovers. The stale toast is dropped and the window is spent.
    act(() => appState()({ isActive: false }))
    raiseLossAlert()
    act(() => new Socket(GATEWAY_URL).fire('open'))
    expect($notifications.get()).toEqual([])

    // A second outage, this time on a VISIBLE app. A later socket opening must
    // leave it alone: if the edge outlived its window, the rule would silently
    // mean "every alert since the first background" (reviewer probe B).
    const id = raiseLossAlert()
    act(() => new Socket(GATEWAY_URL).fire('open'))
    expect($notifications.get().map((n) => n.id)).toEqual([id])

    view.unmount()
  })
})
