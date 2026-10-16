/**
 * rooms-only.ts — the pure half of the mobile room-mode override (HM-14).
 *
 * Kept free of any upstream import so it can be unit-tested without pulling the
 * renderer's plugin SDK into a node test environment. The shim
 * (`canonical-group-capabilities.ts`) applies this to the upstream decision.
 *
 * Why: `groupExecutionMode` returns 'canonical' when the gateway runs the room
 * driver, and 'legacy' otherwise. `legacy` is the branch that lets the renderer
 * keep rooms ON THE DEVICE. Option D says the gateway is the only source of
 * truth, so on mobile a non-canonical gateway is 'unavailable' — the app must
 * refuse to hold rooms locally, not silently fall back to device-only rooms
 * that Desktop can never see.
 */
export type GroupExecutionMode = 'canonical' | 'legacy' | 'unavailable'

/**
 * Demoite 'legacy' to 'unavailable'. 'canonical' and 'unavailable' pass through
 * unchanged: this narrows exactly one branch and nothing else.
 */
export function roomsOnlyMode(mode: GroupExecutionMode): GroupExecutionMode {
  return mode === 'legacy' ? 'unavailable' : mode
}

/**
 * Shown when the gateway serves no room driver. The renderer owns room UI, so
 * this constant is what a renderer change (or a future override) should render;
 * until then it documents the intended guidance and points at the fix.
 */
export const ROOMS_UNAVAILABLE_HINT =
  'This gateway does not run the hosted-room driver, so rooms cannot be shared with Desktop. ' +
  'Enable it per docs/GATEWAY_SETUP.md, then reopen the Bots tab.'
