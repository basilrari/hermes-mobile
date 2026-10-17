/**
 * TraceBadge.tsx — the debug RPC-trace affordance (HM-05).
 *
 * A small "Hermes v<version>" label, pinned to a corner. Long-press (600 ms)
 * exports the RPC trace as a text file and opens the native share sheet, so on
 * the tablet Basil can produce a trace when a checklist item fails without
 * adb. A short tap shows the current entry count.
 *
 * Renders nothing when the build disables the trace (`VITE_HERMES_TRACE=false`),
 * i.e. in a release build.
 */

import { useEffect, useRef, useState } from 'react'

import { shareTextFile } from '~bridge/native'
import { rpcTrace, traceEnabled } from '~bridge/rpc-trace'

const LONG_PRESS_MS = 600

export function TraceBadge() {
  const enabled = traceEnabled()
  const [note, setNote] = useState<string | null>(null)
  const timer = useRef<number | null>(null)
  // Round-1 finding: the click that ends a long-press also fired onClick and
  // clobbered the share result note. Remember that the press was long.
  const longPressFired = useRef(false)

  const cancel = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  useEffect(() => cancel, [])

  async function shareTrace() {
    const text = rpcTrace.toText({ app: __HERMES_APP_VERSION__, entries: rpcTrace.size })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const ok = await shareTextFile(`hermes-trace-${stamp}.txt`, text)
    setNote(ok ? 'shared' : 'share failed')
    window.setTimeout(() => setNote(null), 3000)
  }

  if (!enabled) return null

  return (
    <button
      type="button"
      aria-label="Hermes debug trace (long-press to share)"
      title="Long-press to share the RPC trace"
      className="fixed bottom-2 left-2 z-[2000] rounded-md bg-black/40 px-2 py-1 text-[10px] leading-none text-white/70 backdrop-blur"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={() => {
        cancel()
        longPressFired.current = false
        timer.current = window.setTimeout(() => {
          timer.current = null
          longPressFired.current = true
          void shareTrace()
        }, LONG_PRESS_MS)
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onClick={() => {
        if (longPressFired.current) {
          longPressFired.current = false
          return
        }
        setNote(`${rpcTrace.size} entries`)
      }}
    >
      Hermes v{__HERMES_APP_VERSION__}
      {note ? ` · ${note}` : ''}
    </button>
  )
}
