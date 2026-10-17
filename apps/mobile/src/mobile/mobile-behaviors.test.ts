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
import { $notifications } from '@/store/notifications'

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

/** A window whose WebSocket records itself and can fire `open`/`close`. */
function lifecycleWindow() {
  const created: { fire: (type: string) => void }[] = []
  const win = {
    WebSocket: function () {
      const handlers = new Map<string, Array<() => void>>()
      const socket = {
        readyState: 1,
        close() {
          socket.readyState = 3
          socket.fire('close')
        },
        addEventListener(type: string, fn: () => void) {
          handlers.set(type, [...(handlers.get(type) ?? []), fn])
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

/** The sticky escalation toast the boot hook raises while the ladder fails. */
function lossAlert(id: string) {
  return {
    id,
    kind: 'warning' as const,
    title: translateNow('boot.errors.gatewayConnectionLost'),
    message: 'Hermes lost its connection',
    createdAt: Date.now() + 1,
  }
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

  it('clears the flag when it unmounts while hidden, so the next mount can dial', () => {
    const view = mount()

    act(() => appState()({ isActive: false }))
    expect(isSuspended()).toBe(true)

    // The 401 path: the component goes away while the app is still hidden.
    view.unmount()
    expect(isSuspended()).toBe(false)

    // Next login remounts. The plugin does not replay `isActive: true`, so this
    // mount is the only thing that can open the gate again.
    const again = mount()
    expect(isSuspended()).toBe(false)

    act(() => appState()({ isActive: false }))
    expect(isSuspended()).toBe(true)
    again.unmount()
    expect(isSuspended()).toBe(false)
  })
})

describe('the connection-lost toast is dismissed only on recovery (HM-32)', () => {
  it('keeps the alert on resume when the gateway is still down', () => {
    const view = mount()
    act(() => appState()({ isActive: false }))

    // The escalation fires while hidden (300 s of suppressed ladder steps) and
    // the gateway is genuinely dead, so nothing opens on resume.
    $notifications.set([lossAlert('lost')])

    act(() => appState()({ isActive: true }))

    // Coming back on screen is not evidence of recovery: the toast is the only
    // actionable thing the user has, and the next escalation is ~300 s away.
    expect($notifications.get().map((n) => n.id)).toEqual(['lost'])
    view.unmount()
  })

  it('dismisses the alert once a socket opens', () => {
    const { win, created } = lifecycleWindow()
    installSocketLifecycle(win as never)
    const view = mount()
    act(() => appState()({ isActive: false }))
    $notifications.set([lossAlert('lost')])

    // The post-resume dial succeeds: an open socket is proof, not a proxy.
    const Socket = win.WebSocket as unknown as new (url: string) => { fire: (t: string) => void }
    const socket = new Socket('wss://gw.example/ws')
    expect(created).toHaveLength(1)
    act(() => socket.fire('open'))

    expect($notifications.get()).toEqual([])
    view.unmount()
  })
})
