import { describe, expect, it, vi } from 'vitest'

// The plugin is the only thing under test here; the rest of native.ts is not
// exercised, but its other imports must still resolve. The mock factory is
// hoisted above ordinary bindings, so the fn it returns must be created inside
// `vi.hoisted`.
const { addListener } = vi.hoisted(() => ({ addListener: vi.fn() }))

vi.mock('@capacitor/app', () => ({ App: { addListener } }))

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
})
