import { describe, expect, it, vi } from 'vitest'

// The plugin is the only thing under test here; the rest of native.ts is not
// exercised, but its other imports must still resolve. The mock factory is
// hoisted above ordinary bindings, so the fn it returns must be created inside
// `vi.hoisted`.
const { addListener } = vi.hoisted(() => ({ addListener: vi.fn() }))

vi.mock('@capacitor/app', () => ({ App: { addListener } }))

import { onLifecycleGap, resetLifecycleGapForTests } from './lifecycle-gap'
import { onAppStateChange } from './native'

describe('onAppStateChange (HM-32)', () => {
  it('warns once instead of failing silently when the listener cannot register', async () => {
    addListener.mockRejectedValueOnce(new Error('plugin unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const stop = onAppStateChange(() => {})
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))

    expect(String(warn.mock.calls[0][0])).toMatch(/appStateChange/)
    stop()
    warn.mockRestore()
  })

  it('names the rejection code, not the constant `Error` a CapacitorException carries', async () => {
    // `@capacitor/core` sets message/code/data and never `name`, so `err.name` is
    // `Error` for every plugin rejection: it could say the control was off but not
    // which way it failed. `code` separates them and is still not free text.
    const seen: string[] = []
    resetLifecycleGapForTests()
    onLifecycleGap((note) => seen.push(note))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    addListener.mockRejectedValueOnce({
      code: 'UNIMPLEMENTED',
      message: '"App" plugin is not implemented on android',
    })

    const stop = onAppStateChange(() => {})
    await vi.waitFor(() => expect(seen).toHaveLength(1))

    expect(seen[0]).toContain('UNIMPLEMENTED')
    // Still bounded: no message text, no stack.
    expect(seen[0]).not.toContain('not implemented on android')
    stop()
    warn.mockRestore()
  })
})
