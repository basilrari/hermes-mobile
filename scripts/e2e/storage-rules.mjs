/**
 * storage-rules.mjs — the on-device storage classification used by the harness
 * (HM-13), extracted so it is unit-testable outside the browser run.
 *
 * Rule (Option D): the device holds UI preferences and bridge state. Never
 * conversation state.
 *
 * Round-1 finding: the first version's deny-list ended in
 * `preparedSubmissions\.v1$`, which ALSO matches the legitimate bridge journal
 * key `CapacitorStorage.hermes.preparedSubmissions.v1` — so the gate would have
 * failed the moment a send was journalled, i.e. exactly when HM-12 started
 * working. The forbidden key is the RENDERER's own localStorage fallback
 * (`hermes.desktop.preparedSubmissions.v1`), so it is anchored to that prefix.
 */

/** The renderer's own localStorage fallback for the send journal (forbidden). */
export const RENDERER_JOURNAL_FALLBACK = 'hermes.desktop.preparedSubmissions.v1'

/** Keys that must never appear: messages, room logs, session history. */
export const CONVERSATION_STATE = [
  // Anchored: only the RENDERER's fallback, never our Capacitor journal.
  new RegExp(`^${RENDERER_JOURNAL_FALLBACK.replace(/\./g, '\\.')}$`),
  // Final segment, not a substring. group-chat.ts stores under `group-chats`
  // and `group-chat-tombstones`; plugin storage prefixes that to
  // `hermes.plugin.hermes-bots.group-chats`. A bare /group-chat/i also matches
  // layout keys (`ui-group-chat-width`, `hermes.desktop.layout.group-chat-panel`).
  /(^|\.)group-chats?(-tombstones)?$/i,
  /(^|[.\-_/])(messages|rooms?|sessions?|history)([.\-_/]|$)/i,
  // Crash journal: the user prompt and the streamed assistant rows
  // (inflight-turn-journal.ts). v1 is the legacy store; v2: is one entry per
  // session. The migration flag (`...v2.migrated`) is not a payload.
  /^hermes\.desktop\.inflightTurnJournal\.v1$/,
  /^hermes\.desktop\.inflightTurnJournal\.v2:/,
  // Queued prompt text, including an expanded skill body (composer-queue.ts).
  // Exact: the store is one key, not a prefix.
  /^hermes\.desktop\.composerQueue\.v1$/,
]

/** Patterns actually observed on a full login + boot; classified in ARCHITECTURE.md. */
export const KNOWN_STORAGE = [
  {
    match: /^CapacitorStorage\.hermes\.(target|cookies\..+|preparedSubmissions\.v1|device\.[a-z]+\.v1)$/,
    kind: 'bridge state',
    note: 'user-entered target/cookies, the send journal, the device id',
  },
  { match: /^hermes-boot-/, kind: 'ui pref', note: 'boot theme/background' },
  { match: /^hermes-desktop-active-profile-v1$/, kind: 'ui pref', note: 'last active profile' },
  {
    match: /^hermes\.desktop\.inflightTurnJournal\.v(1$|2:)/,
    kind: 'conversation state',
    note: 'denied: user prompt and streamed assistant rows',
  },
  {
    match: /^hermes\.desktop\.composerQueue\.v1$/,
    kind: 'conversation state',
    note: 'denied: queued prompt text, including an expanded skill body',
  },
  { match: /^hermes\.desktop\./, kind: 'ui pref / rebuildable cache', note: 'layout, panes, tools, theme, tutorials, pricing' },
  { match: /^hermes\.updates\.last-passive-check$/, kind: 'ui pref', note: 'update check timestamp' },
]

/** True when a key holds conversation state and must not be on the device. */
export function isConversationState(key) {
  return CONVERSATION_STATE.some((rule) => rule.test(key))
}

/** Classify one key. Returns { kind, note, known }. */
export function classifyStorageKey(key) {
  for (const rule of KNOWN_STORAGE) {
    if (rule.match.test(key)) return { kind: rule.kind, note: rule.note, known: true }
  }
  return { kind: 'UNCLASSIFIED', note: 'add a row to docs/ARCHITECTURE.md and a rule here', known: false }
}
