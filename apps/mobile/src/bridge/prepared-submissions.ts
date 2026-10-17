/**
 * prepared-submissions.ts — the durable send journal (HM-12).
 *
 * The renderer's send path uses `window.hermesDesktop.preparedSubmissions` when it
 * exists and otherwise falls back to `localStorage` (`localStorage` is
 * "reload recovery, not process-crash safety"). Android kills background
 * WebViews often, so a pending room send can be lost or duplicated. This module
 * implements the Electron contract (apps/desktop/electron/preload.ts) on top of
 * Capacitor Preferences, which is native storage on a device — so the journal
 * never lands in `localStorage` and is written to the app's own storage rather
 * than the WebView's.
 *
 * DURABILITY, STATED HONESTLY (round-1 finding): Capacitor Android's
 * `Preferences.set` ends in `SharedPreferences.Editor.apply()`, which is
 * asynchronous to disk — it writes on a background thread and does not fsync
 * before returning. So this is durable across app restarts and a clean kill, but
 * it is NOT an fsync-before-ack guarantee and this module no longer claims one.
 * A true guarantee needs `commit()`/fsync, which the plugin does not expose.
 * The `compareAndSet` ordering property is unaffected: it is in-process.
 *
 * Contract (frozen at G0, planning/contracts/bridge-additions.md):
 *   read()                     → the whole journal as one JSON string; "{}" when
 *                                empty, never a rejection for a missing key.
 *   update(key, entry)         → `entry === null` deletes the key.
 *   compareAndSet(k, exp, e)   → atomic; applies only while the stored value is
 *                                exactly `expected` (`null` = absent). `current`
 *                                is what is stored afterwards. Concurrent
 *                                callers are serialised, so two overlapping CAS
 *                                calls cannot both observe the same `expected`.
 *
 * A corrupt store recovers to `{}` rather than throwing into the send path.
 * The journal value is opaque here: it is never parsed for prompts and never
 * copied anywhere else.
 */

import { Preferences } from '@capacitor/preferences'

/** Native-storage key for the journal. */
export const PREPARED_SUBMISSIONS_KEY = 'hermes.preparedSubmissions.v1'

/**
 * The renderer's own `localStorage` fallback. Exported so tests and the harness
 * can prove the bridge keeps it empty (acceptance: no journal text in
 * localStorage).
 */
export const PREPARED_SUBMISSIONS_FALLBACK_KEY = 'hermes.desktop.preparedSubmissions.v1'

export interface PreparedSubmissions {
  read(): Promise<string>
  update(key: string, entry: string | null): Promise<void>
  compareAndSet(
    key: string,
    expected: string | null,
    entry: string | null,
  ): Promise<{ applied: boolean; current: string | null }>
}

/** The slice of Capacitor Preferences this module needs (injectable for tests). */
export interface StringStore {
  get(options: { key: string }): Promise<{ value: string | null }>
  set(options: { key: string; value: string }): Promise<void>
}

type Journal = Record<string, string>

/** Parse a journal blob, tolerating anything corrupt by recovering to `{}`. */
function parseJournal(value: string | null): Journal {
  if (!value) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Journal = {}
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

/** Read a key as the contract's `string | null` (absent = null). */
function currentOf(journal: Journal, key: string): string | null {
  return Object.prototype.hasOwnProperty.call(journal, key) ? journal[key] : null
}

export function createPreparedSubmissions(
  store: StringStore = Preferences,
  storageKey: string = PREPARED_SUBMISSIONS_KEY,
): PreparedSubmissions {
  let cache: Journal | null = null
  // Serialises every operation: no two can interleave between read and write, so
  // a compareAndSet cannot observe a state another call is about to replace.
  let tail: Promise<unknown> = Promise.resolve()

  function serialise<T>(operation: () => Promise<T>): Promise<T> {
    const run = tail.then(operation, operation)
    // Keep the chain alive across a rejection; the caller still sees it.
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function load(): Promise<Journal> {
    if (cache) return cache
    const { value } = await store.get({ key: storageKey })
    cache = parseJournal(value)
    return cache
  }

  async function persist(journal: Journal): Promise<void> {
    await store.set({ key: storageKey, value: JSON.stringify(journal) })
  }

  return {
    read: () => serialise(async () => JSON.stringify(await load())),

    update: (key, entry) =>
      serialise(async () => {
        const journal = await load()
        if (entry === null && !Object.prototype.hasOwnProperty.call(journal, key)) return
        const next: Journal = { ...journal }
        if (entry === null) delete next[key]
        else next[key] = entry
        // Persist FIRST, then adopt. Round-1 finding: assigning into the cached
        // object before the write meant a failed persist left the cache claiming
        // a value the device does not hold — and `read()` is what the renderer
        // uses to decide what to re-send.
        await persist(next)
        cache = next
      }),

    compareAndSet: (key, expected, entry) =>
      serialise(async () => {
        const journal = await load()
        const current = currentOf(journal, key)
        if (current !== expected) {
          return { applied: false, current }
        }
        const next: Journal = { ...journal }
        if (entry === null) delete next[key]
        else next[key] = entry
        await persist(next)
        cache = next
        return { applied: true, current: currentOf(next, key) }
      }),
  }
}

/** The bridge singleton (one journal per app). */
export const preparedSubmissions: PreparedSubmissions = createPreparedSubmissions()
