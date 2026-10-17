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
})
