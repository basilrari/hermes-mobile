// @vitest-environment jsdom
/**
 * The bound on the deferred boot reload must hand the screen back (HM-32,
 * round 13 W2).
 *
 * `reloadWhenVisible` no longer reloads on a clock; at `HIDDEN_RELOAD_TIMEOUT_MS`
 * it calls `onTimeout`, and this component's answer to that is the whole remedy
 * for round 11's dead end: drop the "Reconnecting…" cover so the manual failure
 * surface is reachable. The cover is `z-[1500]` and `BootFailureOverlay` is
 * `--z-setup: 1400` (`styles.css`), so while the cover is mounted the recovery
 * path is masked — which is why removing the `onTimeout` wiring entirely used to
 * leave the suite green (round 13 W2): nothing asserted the cover ever goes away.
 *
 * jsdom + `@testing-library/react` are hoisted from `apps/desktop`; no new
 * dependency, and the component is split out of `app.tsx` so the desktop tree is
 * not mounted for this.
 */
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetSocketLifecycleForTests, setSuspended } from '~bridge/socket-lifecycle'
import { HIDDEN_RELOAD_TIMEOUT_MS } from '~mobile/boot-reload'

import { BootAutoRetry } from './boot-auto-retry'

/** The cover this component renders while a reload is pending. */
function coverText(): string | null {
  return document.body.textContent?.includes('Reconnecting…') ? 'Reconnecting…' : null
}

const originalVisibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

/** Put the boot store in the terminal-failure shape this component reacts to. */
async function failBoot(): Promise<typeof import('@/store/boot')> {
  const boot = await import('@/store/boot')
  boot.$desktopBoot.set({
    error: 'gateway did not answer',
    fakeMode: false,
    message: 'failed',
    phase: 'renderer.init',
    progress: 0,
    running: false,
    timestamp: Date.now(),
    visible: true,
  })
  return boot
}

describe('BootAutoRetry (HM-32)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.sessionStorage.clear()
    resetSocketLifecycleForTests()
    setSuspended(true) // hidden, as the gate sees it
    setVisibility('hidden')
  })

  afterEach(async () => {
    cleanup()
    vi.useRealTimers()
    window.sessionStorage.clear()
    // Drop the own accessor this suite defined, then restore the prototype's, so
    // other suites see a real visibilityState (round 15).
    delete (document as unknown as { visibilityState?: unknown }).visibilityState
    if (originalVisibility) Object.defineProperty(Document.prototype, 'visibilityState', originalVisibility)
    setSuspended(false)
    const boot = await import('@/store/boot')
    boot.$desktopBoot.set({ ...boot.$desktopBoot.get(), error: null, running: true })
  })

  it('drops the cover when the bound expires, so the failure surface is reachable', async () => {
    const boot = await failBoot()
    render(createElement(BootAutoRetry))

    // The 1.1 s warm-up, then the cover is up while the reload waits for the screen.
    await act(async () => {
      vi.advanceTimersByTime(1100)
    })
    expect(coverText()).toBe('Reconnecting…')

    // Still hidden and still inside the bound: the cover stays.
    await act(async () => {
      vi.advanceTimersByTime(HIDDEN_RELOAD_TIMEOUT_MS - 1)
    })
    expect(coverText()).toBe('Reconnecting…')

    // The bound expires while hidden — the cover goes, the overlay underneath is
    // the user's only way back, and no reload fired.
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(coverText()).toBeNull()
    expect(boot.$desktopBoot.get().error).toBe('gateway did not answer')
  })

  it('drops the cover when the boot recovers without a reload', async () => {
    const boot = await failBoot()
    render(createElement(BootAutoRetry))

    await act(async () => {
      vi.advanceTimersByTime(1100)
    })
    expect(coverText()).toBe('Reconnecting…')

    // The boot comes back by another route while the waiter is still armed for a
    // reload: nothing reloads, so nothing else would ever clear the cover, and it
    // is z-1500 over an app that already works (round 21 S3).
    await act(async () => {
      boot.$desktopBoot.set({ ...boot.$desktopBoot.get(), error: null, running: true })
    })
    expect(coverText()).toBeNull()
  })

  it('keeps the budget a reload landed with until the boot completes (round 22 W4)', async () => {
    const boot = await import('@/store/boot')
    window.sessionStorage.setItem('hermes-boot-retries', '1')

    // A cold mount is `running: true, error: null` — a boot in progress, not a
    // connection. Clearing there ran before this boot had a chance to fail, so the
    // counter the reload landed with was wiped and `tries >= MAX_TRIES` was
    // unreachable across reloads.
    boot.$desktopBoot.set({ ...boot.$desktopBoot.get(), error: null, running: true })
    render(createElement(BootAutoRetry))
    expect(window.sessionStorage.getItem('hermes-boot-retries')).toBe('1')

    // The connection edge (`completeDesktopBoot`: `running: false`) refunds it.
    await act(async () => {
      boot.$desktopBoot.set({ ...boot.$desktopBoot.get(), error: null, running: false })
    })
    expect(window.sessionStorage.getItem('hermes-boot-retries')).toBeNull()
  })
})
