// @vitest-environment jsdom
/**
 * Pins the wiring that round 16's fix lives or dies on (HM-32, round 17).
 *
 * `reloadWhenVisible` re-checks "on screen" on two channels, but it only gets the
 * second one if the caller hands it over. Deleting the `watchResume` line in
 * `BootAutoRetry` used to leave the whole suite green: the module's own test injects
 * both channels by hand, so it proved the idea and not the integration. This file
 * asserts the component subscribes, and that the channel it subscribes to is the
 * app-state one whose edge the gate moves on.
 */
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { listeners, reloadWhenVisible } = vi.hoisted(() => ({
  listeners: [] as ((active: boolean) => void)[],
  reloadWhenVisible: vi.fn(() => vi.fn()),
}))

vi.mock('~bridge/native', () => ({
  onAppStateChange: (cb: (active: boolean) => void) => {
    listeners.push(cb)
    return () => {
      listeners.length = 0
    }
  },
}))

vi.mock('~mobile/boot-reload', () => ({
  HIDDEN_RELOAD_TIMEOUT_MS: 60_000,
  reloadWhenVisible,
}))

import { $desktopBoot } from '@/store/boot'
import { BootAutoRetry } from './boot-auto-retry'

/** The last options object the component handed to `reloadWhenVisible`. */
function callOptions(): {
  onTimeout?: () => void
  isOnScreen?: () => boolean
  watchResume?: (recheck: () => void) => () => void
} {
  const call = reloadWhenVisible.mock.calls.at(-1) as unknown as
    | [unknown, { [k: string]: unknown }]
    | undefined
  return (call?.[1] ?? {}) as never
}

describe('BootAutoRetry wiring (HM-32)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    listeners.length = 0
    reloadWhenVisible.mockClear()
    window.sessionStorage.clear()
    $desktopBoot.set({
      error: 'gateway did not answer',
      fakeMode: false,
      message: 'failed',
      phase: 'renderer.init',
      progress: 0,
      running: false,
      timestamp: Date.now(),
      visible: true,
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    window.sessionStorage.clear()
    $desktopBoot.set({ ...$desktopBoot.get(), error: null, running: true })
  })

  it('subscribes the waiter to the app-state channel, so the gate opening is a wake-up', async () => {
    render(createElement(BootAutoRetry))
    await act(async () => {
      vi.advanceTimersByTime(1100)
    })

    expect(reloadWhenVisible).toHaveBeenCalledTimes(1)
    const options = callOptions()
    expect(typeof options.watchResume).toBe('function')

    // The channel it subscribes to is `onAppStateChange`.
    const recheck = vi.fn()
    const unsubscribe = options.watchResume!(recheck)
    expect(listeners).toHaveLength(1)

    // Foregrounding wakes the waiter; backgrounding does not.
    listeners[0](false)
    expect(recheck).not.toHaveBeenCalled()
    listeners[0](true)
    expect(recheck).toHaveBeenCalledTimes(1)

    unsubscribe()
  })
})
