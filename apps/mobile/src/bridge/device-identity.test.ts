import { describe, expect, it, vi } from 'vitest'

// The module imports @capacitor/preferences at load; every test injects a store.
vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}))

import {
  createDeviceIdentity,
  defaultDeviceLabel,
  DEVICE_ID_STORAGE,
  DEVICE_LABEL_STORAGE,
  isUuidV4,
  MAX_LABEL_CHARS,
  randomUuidV4,
  type DeviceStore,
} from './device-identity'

/** In-memory Capacitor Preferences double. */
function fakeStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    data,
    async get({ key }: { key: string }) {
      return { value: key in data ? data[key] : null }
    },
    async set({ key, value }: { key: string; value: string }) {
      data[key] = value
    },
    async remove({ key }: { key: string }) {
      delete data[key]
    },
  } satisfies DeviceStore & { data: Record<string, string> }
}

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-X200 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36'

describe('randomUuidV4', () => {
  it('is a canonical lowercase v4 uuid', () => {
    for (let i = 0; i < 50; i++) expect(isUuidV4(randomUuidV4())).toBe(true)
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomUuidV4()))
    expect(seen.size).toBe(200)
  })
})

describe('defaultDeviceLabel', () => {
  it('reads the Android model out of the WebView user agent', () => {
    expect(defaultDeviceLabel(ANDROID_UA)).toBe('SM-X200')
  })

  it('falls back to a platform word, never anything unique', () => {
    expect(defaultDeviceLabel('Mozilla/5.0 (Linux; Android 14; wv)')).toBe('Android device')
    expect(defaultDeviceLabel('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Hermes mobile')
    expect(defaultDeviceLabel('')).toBe('Hermes mobile')
  })
})

describe('deviceIdentity — the contract', () => {
  it('returns exactly { device_id, label } with a v4 uuid', async () => {
    const identity = await createDeviceIdentity(fakeStore()).deviceIdentity()
    expect(Object.keys(identity).sort()).toEqual(['device_id', 'label'])
    expect(isUuidV4(identity.device_id)).toBe(true)
    expect(typeof identity.label).toBe('string')
  })

  it('is the same id across a relaunch (a fresh instance over the same store)', async () => {
    const store = fakeStore()
    const first = await createDeviceIdentity(store).deviceIdentity()
    const afterRelaunch = await createDeviceIdentity(store).deviceIdentity()
    expect(afterRelaunch.device_id).toBe(first.device_id)
  })

  it('generates a NEW id when the app data is cleared', async () => {
    const store = fakeStore()
    const first = await createDeviceIdentity(store).deviceIdentity()
    store.data[DEVICE_ID_STORAGE] && delete store.data[DEVICE_ID_STORAGE] // app data cleared
    const afterClear = await createDeviceIdentity(store).deviceIdentity()
    expect(afterClear.device_id).not.toBe(first.device_id)
    expect(isUuidV4(afterClear.device_id)).toBe(true)
  })

  it('generates the id ONCE under concurrent first calls', async () => {
    const store = fakeStore()
    const handle = createDeviceIdentity(store)
    const [a, b, c] = await Promise.all([handle.deviceIdentity(), handle.deviceIdentity(), handle.deviceIdentity()])
    expect(new Set([a.device_id, b.device_id, c.device_id]).size).toBe(1)
  })

  it('replaces a stored value that is not a v4 uuid', async () => {
    const store = fakeStore({ [DEVICE_ID_STORAGE]: 'not-a-uuid' })
    const { device_id } = await createDeviceIdentity(store).deviceIdentity()
    expect(isUuidV4(device_id)).toBe(true)
    expect(store.data[DEVICE_ID_STORAGE]).toBe(device_id)
  })

  it('stores only the id and the label — no hardware identifier anywhere', async () => {
    const store = fakeStore()
    await createDeviceIdentity(store, () => 'Pixel Tablet').deviceIdentity()
    expect(Object.keys(store.data).sort()).toEqual([DEVICE_ID_STORAGE, DEVICE_LABEL_STORAGE])
    const serialised = JSON.stringify(store.data)
    for (const banned of ['serial', 'android_id', 'mac', 'imei', 'ip_address']) {
      expect(serialised.toLowerCase()).not.toContain(banned)
    }
  })
})

describe('deviceIdentity — the label', () => {
  it('defaults to the device model and persists it', async () => {
    const store = fakeStore()
    const handle = createDeviceIdentity(store, () => 'SM-X200')
    expect((await handle.deviceIdentity()).label).toBe('SM-X200')
    expect(store.data[DEVICE_LABEL_STORAGE]).toBe('SM-X200')
    expect((await createDeviceIdentity(store).deviceIdentity()).label).toBe('SM-X200')
  })

  it('is editable and persisted', async () => {
    const store = fakeStore()
    const handle = createDeviceIdentity(store, () => 'SM-X200')
    expect(await handle.setDeviceLabel('Basil’s tablet')).toBe('Basil’s tablet')
    expect((await createDeviceIdentity(store).deviceIdentity()).label).toBe('Basil’s tablet')
  })

  it('caps the label at 200 characters', async () => {
    const handle = createDeviceIdentity(fakeStore(), () => 'x'.repeat(500))
    expect((await handle.deviceIdentity()).label).toHaveLength(MAX_LABEL_CHARS)
    expect(await handle.setDeviceLabel('y'.repeat(500))).toHaveLength(MAX_LABEL_CHARS)
  })

  it('rejects an empty label rather than storing a blank device name', async () => {
    const handle = createDeviceIdentity(fakeStore())
    await expect(handle.setDeviceLabel('   ')).rejects.toThrow(/must not be empty/)
  })

  it('re-derives a stored label that clamps to empty', async () => {
    for (const blank of ['   ', ' \t\n ', ' '.repeat(MAX_LABEL_CHARS + 8)]) {
      const store = fakeStore({ [DEVICE_LABEL_STORAGE]: blank })
      const handle = createDeviceIdentity(store, () => 'SM-X200')
      expect((await handle.deviceIdentity()).label).toBe('SM-X200')
      expect(store.data[DEVICE_LABEL_STORAGE]).toBe('SM-X200')
    }
  })
})
