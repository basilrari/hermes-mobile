import { beforeEach, describe, expect, it } from 'vitest'

import { makeStubs } from './stubs'
import { noteDialSuppressed, resetSocketLifecycleForTests, setSuspended } from './socket-lifecycle'

beforeEach(() => {
  resetSocketLifecycleForTests()
})

describe('getBootProgress (HM-32 boot gate)', () => {
  it('marks the boot retryable when the gate refused this dial', async () => {
    // `bootFailureIsRetryable` reads `snapshot.retryable === true`
    // (use-gateway-boot.ts:404-412). A refused dial is transient, so the boot takes
    // the hook's retry loop instead of failing with "Hermes couldn't start" and the
    // internal suppression string in the detail line. The gate records the refusal
    // itself (connection.ts); that is what the stub reports on.
    setSuspended(true)
    noteDialSuppressed()
    const snapshot = await makeStubs().getBootProgress()
    expect(snapshot.retryable).toBe(true)
  })

  it('does not make an unrelated failure retryable just because the app is hidden', async () => {
    // A 401 during a backgrounded boot is a confirmed reauth rejection: the hooks
    // comment at use-gateway-boot.ts:136-143 says that class never enters the retry
    // loop. `isSuspended()` is true for the whole hidden window, so it cannot be the
    // test — only a recorded refusal can.
    setSuspended(true)
    const snapshot = await makeStubs().getBootProgress()
    expect(snapshot.retryable).toBeUndefined()
  })

  it('forgets a refusal older than the attempt being classified', async () => {
    setSuspended(true)
    noteDialSuppressed(Date.now() - 5_000)
    const snapshot = await makeStubs().getBootProgress()
    expect(snapshot.retryable).toBeUndefined()
  })

  it('leaves the snapshot as it was when the gate is open', async () => {
    const snapshot = await makeStubs().getBootProgress()
    expect(snapshot.retryable).toBeUndefined()
    expect(snapshot.phase).toBe('ready')
  })
})
