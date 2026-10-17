import { beforeEach, describe, expect, it, vi } from 'vitest'

import { onLifecycleGap, reportLifecycleGap, resetLifecycleGapForTests } from './lifecycle-gap'

beforeEach(() => {
  resetLifecycleGapForTests()
})

describe('lifecycle gap notes (HM-32)', () => {
  it('always leaves a console line, reporter or not', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportLifecycleGap('no constructor')
    expect(warn).toHaveBeenCalledWith('[hm-32] no constructor')
    warn.mockRestore()
  })

  it('hands notes raised before boot reached the trace to the late reporter', () => {
    // boot.ts installs the socket lifecycle BEFORE the trace; a constructor that
    // is missing is reported in that order, so the note has to be buffered.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportLifecycleGap('raised during boot')
    const seen: string[] = []
    onLifecycleGap((m) => seen.push(m))
    expect(seen).toEqual(['raised during boot'])
  })

  it('stops delivering after the reporter unsubscribes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    const off = onLifecycleGap((m) => seen.push(m))
    reportLifecycleGap('one')
    off()
    reportLifecycleGap('two')
    expect(seen).toEqual(['one'])
  })

  it('survives a reporter that throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    onLifecycleGap(() => {
      throw new Error('trace exploded')
    })
    expect(() => reportLifecycleGap('still booting')).not.toThrow()
  })
})
