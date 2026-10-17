/**
 * boot.ts — side-effect module that installs the window.hermesDesktop bridge.
 *
 * Imported as the VERY FIRST import in main.tsx. ES module imports are hoisted
 * and run depth-first in source order, so importing this before any vendored
 * desktop module guarantees window.hermesDesktop exists before that vendored
 * code evaluates (some of it reads the bridge at module top-level).
 */
import { installBridge } from './install-bridge'
import { installSocketLifecycle } from './socket-lifecycle'
import { installRpcTrace } from './rpc-trace'

// Wrap globalThis.WebSocket BEFORE any vendored module can open a socket, so
// every JSON-RPC frame the renderer sends or receives is traced (HM-05).
// The socket registry must wrap WebSocket BEFORE anything opens one, and it runs
// whether or not tracing is enabled — the trace then instruments through it.
installSocketLifecycle()
installRpcTrace()

installBridge()
