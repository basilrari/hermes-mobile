/**
 * device-identity.ts — stable, non-secret device identity (HM-25).
 *
 * Implements `window.hermesDesktop.deviceIdentity()` from the frozen G0 contract
 * (planning/contracts/device-identity.md, bridge-additions.md):
 *
 *   deviceIdentity(): Promise<{ device_id: string; label: string }>
 *
 *   device_id  random UUID, version 4, canonical lowercase 8-4-4-4-12 hex.
 *              Generated once and stored in Capacitor Preferences, so it is the
 *              same for the life of the app's data and a NEW one after the app
 *              data is cleared.
 *   label      display string, default the device model, user-editable, capped
 *              at 200 characters (hosted_rooms.MAX_ACTOR_LABEL_CHARS).
 *
 * It is NOT a secret and is never a hardware identifier: no serial, no Android
 * id, no MAC, no IP. The model string comes from the WebView user agent (a
 * generic model name, like "SM-X200"), and nothing here reads a hardware API.
 * The server only ever stores the string the client sends.
 *
 * Read state is global (read-cursors.md), so this id is used ONLY for per-device
 * resume cursors (`devices.*`, P2). Feature flag absent → the id is still
 * generated and stored, it is just never sent.
 */

import { Preferences } from '@capacitor/preferences'

/** Storage keys (a namespace, not a credential). */
export const DEVICE_ID_STORAGE = 'hermes.device.id.v1'
export const DEVICE_LABEL_STORAGE = 'hermes.device.label.v1'

/** Same cap as an actor label upstream (`hosted_rooms.MAX_ACTOR_LABEL_CHARS`). */
export const MAX_LABEL_CHARS = 200

export interface DeviceIdentity {
  device_id: string
  label: string
}

/** The slice of Capacitor Preferences this module needs (injectable for tests). */
export interface DeviceStore {
  get(options: { key: string }): Promise<{ value: string | null }>
  set(options: { key: string; value: string }): Promise<void>
  remove(options: { key: string }): Promise<void>
}

/** Canonical lowercase UUID v4. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isUuidV4(value: string): boolean {
  return UUID_V4.test(value)
}

/** A v4 UUID, using the platform RNG. Never derived from anything about the device. */
export function randomUuidV4(): string {
  const webCrypto = globalThis.crypto
  if (webCrypto?.randomUUID) return webCrypto.randomUUID()
  // Round-1 finding: the randomUUID branch was optional-chained but the fallback
  // assumed getRandomValues exists. Fail loudly rather than letting an unguarded
  // call produce an undefined-derived id.
  if (!webCrypto?.getRandomValues) {
    throw new Error('no secure random source available: globalThis.crypto.getRandomValues is missing')
  }
  const bytes = new Uint8Array(16)
  webCrypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Best-effort default label: the Android device model out of the WebView user
 * agent (`…; SM-X200 Build/…`). A model name is not a hardware identifier. Falls
 * back to a platform word, never to anything unique.
 */
export function defaultDeviceLabel(userAgent: string = globalThis.navigator?.userAgent ?? ''): string {
  const android = /Android[^;)]*;\s*([^;)]+?)\s+Build[/)]/i.exec(userAgent)
  const model = android?.[1]?.trim()
  if (model && model.length <= 64 && !model.includes('Build')) return model.slice(0, MAX_LABEL_CHARS)
  if (/Android/i.test(userAgent)) return 'Android device'
  return 'Hermes mobile'
}

/** Trim to the contract's cap. */
export function clampLabel(label: string): string {
  return label.trim().slice(0, MAX_LABEL_CHARS)
}

export interface DeviceIdentityHandle {
  /** The contract method. Stable per app-data lifetime. */
  deviceIdentity(): Promise<DeviceIdentity>
  /** Change the display label (persisted). Empty input is rejected, not stored. */
  setDeviceLabel(label: string): Promise<string>
  /** Current label, initialising the default if this is the first call. */
  deviceLabel(): Promise<string>
}

export function createDeviceIdentity(
  store: DeviceStore = Preferences,
  fallbackLabel: () => string = () => defaultDeviceLabel(),
): DeviceIdentityHandle {
  // One in-flight promise, so two overlapping first calls generate ONE id.
  let idPromise: Promise<string> | null = null

  async function readOrCreateId(): Promise<string> {
    if (!idPromise) {
      idPromise = (async () => {
        const { value } = await store.get({ key: DEVICE_ID_STORAGE })
        if (value && isUuidV4(value)) return value
        const created = randomUuidV4()
        await store.set({ key: DEVICE_ID_STORAGE, value: created })
        return created
      })().catch((error: unknown) => {
        // A failed write must not poison the memo for later calls.
        idPromise = null
        throw error
      })
    }
    return idPromise
  }

  async function deviceLabel(): Promise<string> {
    const { value } = await store.get({ key: DEVICE_LABEL_STORAGE })
    // Round-1 finding: a stored label that clamps to empty (whitespace, or
    // longer than the cap with nothing but padding) was returned as-is, giving
    // the device a blank name. Treat it as missing and re-derive the default.
    const stored = value ? clampLabel(value) : ''
    if (stored) return stored
    const created = clampLabel(fallbackLabel()) || 'Hermes mobile'
    await store.set({ key: DEVICE_LABEL_STORAGE, value: created })
    return created
  }

  return {
    deviceIdentity: async () => ({ device_id: await readOrCreateId(), label: await deviceLabel() }),

    setDeviceLabel: async (label: string) => {
      const next = clampLabel(label)
      if (!next) throw new Error('device label must not be empty')
      await store.set({ key: DEVICE_LABEL_STORAGE, value: next })
      return next
    },

    deviceLabel,
  }
}

/** The bridge singleton. */
export const deviceIdentityHandle: DeviceIdentityHandle = createDeviceIdentity()

/** The `window.hermesDesktop.deviceIdentity` implementation. */
export async function deviceIdentity(): Promise<DeviceIdentity> {
  return deviceIdentityHandle.deviceIdentity()
}
