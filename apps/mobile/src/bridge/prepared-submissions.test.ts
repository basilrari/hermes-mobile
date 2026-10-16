import { describe, expect, it, vi } from 'vitest'

// The module imports @capacitor/preferences at load; every test injects its own
// store, so the plugin only has to exist, not work.
vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn() },
}))

import {
  createPreparedSubmissions,
  PREPARED_SUBMISSIONS_FALLBACK_KEY,
  PREPARED_SUBMISSIONS_KEY,
  type StringStore,
} from './prepared-submissions'

/** In-memory Capacitor Preferences double. */
function fakeStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  const writes: string[] = []
  return {
    data,
    writes,
    async get({ key }: { key: string }) {
      return { value: key in data ? data[key] : null }
    },
    async set({ key, value }: { key: string; value: string }) {
      data[key] = value
      writes.push(value)
    },
  } satisfies StringStore & { data: Record<string, string>; writes: string[] }
}

describe('preparedSubmissions — read/update', () => {
  it('reads an empty journal as "{}", never a rejection', async () => {
    const journal = createPreparedSubmissions(fakeStore())
    await expect(journal.read()).resolves.toBe('{}')
  })

  it('stores, replaces and deletes a key', async () => {
    const store = fakeStore()
    const journal = createPreparedSubmissions(store)
    await journal.update('room-a', '{"text":"one"}')
    await expect(journal.read()).resolves.toBe('{"room-a":"{\\"text\\":\\"one\\"}"}')
    await journal.update('room-a', '{"text":"two"}')
    await expect(journal.read()).resolves.toContain('"text\\":\\"two\\"')
    await journal.update('room-a', null)
    await expect(journal.read()).resolves.toBe('{}')
  })

  it('deleting an absent key is a no-op (no write)', async () => {
    const store = fakeStore()
    const journal = createPreparedSubmissions(store)
    await journal.update('nope', null)
    expect(store.writes).toHaveLength(0)
  })
})

describe('preparedSubmissions — compareAndSet', () => {
  it('applies when the stored value is exactly expected', async () => {
    const journal = createPreparedSubmissions(fakeStore())
    await journal.update('k', 'v1')
    await expect(journal.compareAndSet('k', 'v1', 'v2')).resolves.toEqual({ applied: true, current: 'v2' })
    await expect(journal.read()).resolves.toBe('{"k":"v2"}')
  })

  it('applies against an absent key with expected null', async () => {
    const journal = createPreparedSubmissions(fakeStore())
    await expect(journal.compareAndSet('k', null, 'first')).resolves.toEqual({ applied: true, current: 'first' })
  })

  it('refuses when the key is absent but expected was a value', async () => {
    const journal = createPreparedSubmissions(fakeStore())
    await expect(journal.compareAndSet('k', 'stale', 'new')).resolves.toEqual({ applied: false, current: null })
    await expect(journal.read()).resolves.toBe('{}')
  })

  it('refuses when the key exists but expected was null', async () => {
    const journal = createPreparedSubmissions(fakeStore())
    await journal.update('k', 'present')
    await expect(journal.compareAndSet('k', null, 'new')).resolves.toEqual({ applied: false, current: 'present' })
  })

  it('passes a stale value back as `current` on conflict, and the store is unchanged', async () => {
    const journal = createPreparedSubmissions(fakeStore())
    await journal.update('k', 'theirs')
    await expect(journal.compareAndSet('k', 'mine', 'theirs2')).resolves.toEqual({ applied: false, current: 'theirs' })
    await expect(journal.read()).resolves.toBe('{"k":"theirs"}')
  })

  it('serialises concurrent compareAndSets: exactly one of two identical guards applies', async () => {
    const journal = createPreparedSubmissions(fakeStore())
    await journal.update('k', null) // no-op, keeps the store empty
    await journal.compareAndSet('k', null, 'seed')

    const [a, b] = await Promise.all([
      journal.compareAndSet('k', 'seed', 'candidate-a'),
      journal.compareAndSet('k', 'seed', 'candidate-b'),
    ])
    expect([a.applied, b.applied].filter(Boolean)).toHaveLength(1)
    const applied = a.applied ? a.current : b.current
    await expect(journal.read()).resolves.toBe(JSON.stringify({ k: applied }))
  })

  it('serialises a mixed batch without losing a write', async () => {
    const journal = createPreparedSubmissions(fakeStore())
    await Promise.all([
      journal.update('a', '1'),
      journal.update('b', '2'),
      journal.compareAndSet('c', null, '3'),
      journal.update('d', '4'),
    ])
    const parsed = JSON.parse(await journal.read()) as Record<string, string>
    expect(parsed).toEqual({ a: '1', b: '2', c: '3', d: '4' })
  })
})

describe('preparedSubmissions — durability and the storage key', () => {
  it('recovers a corrupt store to {} instead of throwing into the send path', async () => {
    const store = fakeStore({ [PREPARED_SUBMISSIONS_KEY]: '{not json' })
    const journal = createPreparedSubmissions(store)
    await expect(journal.read()).resolves.toBe('{}')
    await journal.update('k', 'v')
    await expect(journal.read()).resolves.toBe('{"k":"v"}')
  })

  it('drops non-string entries from a store that was tampered with', async () => {
    const store = fakeStore({ [PREPARED_SUBMISSIONS_KEY]: JSON.stringify({ good: 'v', bad: 7, worse: { a: 1 } }) })
    await expect(createPreparedSubmissions(store).read()).resolves.toBe('{"good":"v"}')
  })

  it('survives a fresh instance over the same store (an app relaunch)', async () => {
    const store = fakeStore()
    await createPreparedSubmissions(store).update('pending', '{"text":"hi"}')
    // A new instance has no cache: it must read the store, not memory.
    await expect(createPreparedSubmissions(store).read()).resolves.toBe('{"pending":"{\\"text\\":\\"hi\\"}"}')
  })

  it('writes to native Preferences, never the renderer localStorage key', async () => {
    const store = fakeStore()
    const journal = createPreparedSubmissions(store)
    await journal.update('room', '{"text":"hi"}')
    expect(Object.keys(store.data)).toEqual([PREPARED_SUBMISSIONS_KEY])
    expect(Object.keys(store.data)).not.toContain(PREPARED_SUBMISSIONS_FALLBACK_KEY)
  })
})
