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

import { isSuspended, resetSocketLifecycleForTests, setSuspended } from '~bridge/socket-lifecycle'

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

beforeEach(() => {
  resetSocketLifecycleForTests()
  listeners.length = 0
})

afterEach(() => {
  cleanup()
  resetSocketLifecycleForTests()
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
