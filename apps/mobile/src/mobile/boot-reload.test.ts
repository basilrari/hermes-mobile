import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resetSocketLifecycleForTests, setSuspended } from '~bridge/socket-lifecycle'

import { reloadWhenVisible, type ReloadWindow } from './boot-reload'

/** A document whose visibility the test drives, recording its listeners. */
function fakeWindow(visibility: DocumentVisibilityState) {
  const listeners = new Set<() => void>()
  const reload = vi.fn()
  const doc = {
    visibilityState: visibility,
    addEventListener: (_type: string, fn: () => void) => {
      listeners.add(fn)
    },
    removeEventListener: (_type: string, fn: () => void) => {
      listeners.delete(fn)
    },
  }
  const win: ReloadWindow = { document: doc as never, location: { reload } }
  return {
    win,
    reload,
    listenerCount: () => listeners.size,
    visibility: () => doc.visibilityState,
    /** Report a visibility change after moving the document to `state`. */
    show(state: DocumentVisibilityState) {
      doc.visibilityState = state
      for (const fn of [...listeners]) fn()
    },
  }
}

describe('reloadWhenVisible (HM-32)', () => {
  beforeEach(() => resetSocketLifecycleForTests())

  it('reloads at once while the app is on screen, and registers nothing', () => {
    const fake = fakeWindow('visible')
    const cancel = reloadWhenVisible(fake.win)

    expect(fake.reload).toHaveBeenCalledTimes(1)
    expect(fake.listenerCount()).toBe(0)
    cancel()
    expect(fake.reload).toHaveBeenCalledTimes(1)
  })

  it('waits while hidden: a reload there would re-arm the suspend gate in the background', () => {
    const fake = fakeWindow('hidden')
    reloadWhenVisible(fake.win)

    expect(fake.reload).not.toHaveBeenCalled()

    // Still hidden, or a different non-visible state: nothing happens.
    fake.show('hidden')
    expect(fake.reload).not.toHaveBeenCalled()

    // Back on screen — one reload, and the waiter is gone.
    fake.show('visible')
    expect(fake.reload).toHaveBeenCalledTimes(1)
    expect(fake.listenerCount()).toBe(0)

    fake.show('visible')
    expect(fake.reload).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending reload when the boot recovers another way', () => {
    const fake = fakeWindow('hidden')
    const cancel = reloadWhenVisible(fake.win)

    cancel()
    expect(fake.listenerCount()).toBe(0)

    fake.show('visible')
    expect(fake.reload).not.toHaveBeenCalled()
  })

  it('reports the stall after the bound instead of reloading blind while hidden', () => {
    // A reload here would rerun the bridge with the suspend gate at `false` and
    // dial, mint a ticket and hold that socket for the rest of the hidden window.
    vi.useFakeTimers()
    try {
      const fake = fakeWindow('hidden')
      const onTimeout = vi.fn()
      reloadWhenVisible(fake.win, { timeoutMs: 60_000, onTimeout })

      vi.advanceTimersByTime(59_999)
      expect(onTimeout).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(onTimeout).toHaveBeenCalledTimes(1)
      expect(fake.reload).not.toHaveBeenCalled()
      // Still armed for the visible edge — the stall report is not a give-up.
      expect(fake.listenerCount()).toBe(1)

      vi.advanceTimersByTime(120_000)
      expect(onTimeout).toHaveBeenCalledTimes(1)
      expect(fake.reload).not.toHaveBeenCalled()

      fake.show('visible')
      expect(fake.reload).toHaveBeenCalledTimes(1)
      expect(fake.listenerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the bound when the visible edge wins, or when cancelled', () => {
    vi.useFakeTimers()
    try {
      const shown = fakeWindow('hidden')
      const shownTimeout = vi.fn()
      reloadWhenVisible(shown.win, { timeoutMs: 60_000, onTimeout: shownTimeout })
      shown.show('visible')
      expect(shown.reload).toHaveBeenCalledTimes(1)

      const cancelled = fakeWindow('hidden')
      const cancelledTimeout = vi.fn()
      reloadWhenVisible(cancelled.win, { timeoutMs: 60_000, onTimeout: cancelledTimeout })()

      vi.advanceTimersByTime(120_000)
      expect(shown.reload).toHaveBeenCalledTimes(1)
      expect(shownTimeout).not.toHaveBeenCalled()
      expect(cancelled.reload).not.toHaveBeenCalled()
      expect(cancelledTimeout).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reload on the WebView word alone if the suspend gate disagrees', () => {
    // On Android the two signals come from different places (visibilityState from
    // the WebView, the flag from the activity), so the flag has the last word: a
    // reload here would rerun the bridge with the gate `false` and dial.
    const fake = fakeWindow('visible')
    setSuspended(true)

    const cancel = reloadWhenVisible(fake.win)
    expect(fake.reload).not.toHaveBeenCalled()
    expect(fake.listenerCount()).toBe(1)

    // Still backgrounded per the gate, even with a visible edge.
    fake.show('visible')
    expect(fake.reload).not.toHaveBeenCalled()

    setSuspended(false)
    fake.show('visible')
    expect(fake.reload).toHaveBeenCalledTimes(1)
    expect(fake.listenerCount()).toBe(0)
    cancel()
  })

  it('reloads when the gate opens after the visible edge, without waiting for a second edge', () => {
    // The activity's window is visible before `onResume` clears the gate, so the
    // WebView's edge can arrive first. Sampling the condition once there loses the
    // reload: nothing dispatches another `visibilitychange`. The waiter watches the
    // gate's own channel too, and re-checks when it opens (round 16).
    let gateOpen = false
    let wake: (() => void) | undefined
    const fake = fakeWindow('hidden')

    const cancel = reloadWhenVisible(fake.win, {
      isOnScreen: () => fake.visibility() === 'visible' && gateOpen,
      watchResume: (recheck) => {
        wake = recheck
        return () => {
          wake = undefined
        }
      },
    })

    // Edge first, gate still closed: no reload, still armed.
    fake.show('visible')
    expect(fake.reload).not.toHaveBeenCalled()
    expect(fake.listenerCount()).toBe(1)

    // The gate opens on its own channel — the waiter reloads with no second edge.
    gateOpen = true
    wake?.()
    expect(fake.reload).toHaveBeenCalledTimes(1)
    expect(fake.listenerCount()).toBe(0)
    expect(wake).toBeUndefined()
    cancel()
  })
})
