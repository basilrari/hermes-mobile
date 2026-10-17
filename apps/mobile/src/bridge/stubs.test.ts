import { beforeEach, describe, expect, it } from 'vitest'

import { makeStubs } from './stubs'
import { resetSocketLifecycleForTests, setSuspended } from './socket-lifecycle'

beforeEach(() => {
  resetSocketLifecycleForTests()
})

describe('getBootProgress (HM-32 boot gate)', () => {
  it('marks the boot retryable while the dial gate is closed', async () => {
    // `bootFailureIsRetryable` reads `snapshot.retryable === true`
    // (use-gateway-boot.ts). A dial refused by the HM-32 gate is transient: the
    // app is backgrounded, not broken. Without this the cold boot goes to
    // failDesktopBoot and shows "Hermes couldn't start" with the internal
    // suppression string in the detail line.
    setSuspended(true)
    const snapshot = await makeStubs().getBootProgress()
    expect(snapshot.retryable).toBe(true)
  })

  it('leaves the snapshot as it was when the gate is open', async () => {
    const snapshot = await makeStubs().getBootProgress()
    expect(snapshot.retryable).toBeUndefined()
    expect(snapshot.phase).toBe('ready')
  })
})
