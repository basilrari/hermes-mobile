/**
 * overrides/canonical-group-capabilities.ts — mobile override (HM-14).
 *
 * Replaces `@/plugins/hermes-bots/canonical-group-capabilities` for the whole
 * renderer, through `exactPathOverride` in vite.config.ts. The upstream module
 * is NOT edited and is NOT forked: this shim imports it and narrows one branch.
 *
 * `groupExecutionMode` upstream returns 'legacy' for a gateway that has no room
 * driver — the branch that lets the renderer hold rooms on the device. On mobile
 * that branch is demoted to 'unavailable' (see rooms-only.ts), so every room is
 * a gateway room and Desktop and the app agree. `groupCreationSource` is
 * re-exported untouched: it is the epoch fence for the creation flow and this
 * override has no business changing it.
 *
 * Removal condition: delete once a stock gateway always reports a canonical
 * driver (or upstream stops offering a device-local room fallback).
 */
import {
  groupCreationSource,
  groupExecutionMode as upstreamGroupExecutionMode,
  groupSeatableProfiles,
  seatableGroupBots,
  useGroupCapability as upstreamUseGroupCapability,
} from '@/plugins/hermes-bots/canonical-group-capabilities'

import { roomsOnlyMode } from './rooms-only'

export type { GroupExecutionMode } from './rooms-only'
export type { GroupCapabilityState } from '@/plugins/hermes-bots/canonical-group-capabilities'

export { groupCreationSource, groupSeatableProfiles, seatableGroupBots }

/** Upstream's decision, with the device-local branch removed on mobile. */
export function groupExecutionMode(value: unknown): ReturnType<typeof upstreamGroupExecutionMode> {
  return roomsOnlyMode(upstreamGroupExecutionMode(value))
}

/**
 * v0.22.5 reads the mode from this hook, which calls the upstream function
 * internally. Wrap the published mode the same way. `seatableGroupBots` treats
 * `legacy` as "every bot"; demoting it here keeps that branch off the device.
 */
export function useGroupCapability(active: boolean): ReturnType<typeof upstreamUseGroupCapability> {
  const state = upstreamUseGroupCapability(active)
  const mode = state.mode === 'legacy' ? 'unavailable' : state.mode
  const capability =
    state.capability?.mode === 'legacy' ? { ...state.capability, mode: 'unavailable' as const } : state.capability
  if (mode === state.mode && capability === state.capability) return state
  return { ...state, mode, capability }
}
