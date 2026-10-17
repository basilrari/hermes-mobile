import { describe, expect, it, vi } from 'vitest'

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
    /** Report a visibility change after moving the document to `state`. */
    show(state: DocumentVisibilityState) {
      doc.visibilityState = state
      for (const fn of [...listeners]) fn()
    },
  }
}

describe('reloadWhenVisible (HM-32)', () => {
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

  it('reloads anyway after the bounded fallback, so a lost visibility signal cannot park the boot', () => {
    vi.useFakeTimers()
    try {
      const fake = fakeWindow('hidden')
      reloadWhenVisible(fake.win, 60_000)

      vi.advanceTimersByTime(59_999)
      expect(fake.reload).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(fake.reload).toHaveBeenCalledTimes(1)
      expect(fake.listenerCount()).toBe(0)

      // No second reload from a late visible edge or a repeated tick.
      fake.show('visible')
      vi.advanceTimersByTime(120_000)
      expect(fake.reload).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the fallback timer when the visible edge wins, or when cancelled', () => {
    vi.useFakeTimers()
    try {
      const shown = fakeWindow('hidden')
      reloadWhenVisible(shown.win, 60_000)
      shown.show('visible')
      expect(shown.reload).toHaveBeenCalledTimes(1)

      const cancelled = fakeWindow('hidden')
      reloadWhenVisible(cancelled.win, 60_000)()

      vi.advanceTimersByTime(120_000)
      expect(shown.reload).toHaveBeenCalledTimes(1)
      expect(cancelled.reload).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
