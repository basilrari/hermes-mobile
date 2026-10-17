/**
 * Type declarations for scripts/e2e/storage-rules.mjs, so the unit test under
 * apps/mobile/src can import it with types (the harness itself is plain JS).
 */

/** The renderer's own localStorage fallback for the send journal (forbidden). */
export declare const RENDERER_JOURNAL_FALLBACK: string

/** Patterns that must never appear in on-device storage. */
export declare const CONVERSATION_STATE: RegExp[]

/** Patterns classified as acceptable, with their class. */
export declare const KNOWN_STORAGE: Array<{ match: RegExp; kind: string; note: string }>

/** True when a key holds conversation state and must not be on the device. */
export declare function isConversationState(key: string): boolean

/** Classify one key. */
export declare function classifyStorageKey(key: string): { kind: string; note: string; known: boolean }
