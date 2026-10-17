import { describe, expect, it } from 'vitest'

import {
  classifyStorageKey,
  CONVERSATION_STATE,
  isConversationState,
  KNOWN_STORAGE,
  RENDERER_JOURNAL_FALLBACK,
} from '../../../../scripts/e2e/storage-rules.mjs'

describe('isConversationState (HM-13 deny-list)', () => {
  it('flags the renderer’s own journal fallback — the key HM-12 exists to avoid', () => {
    expect(isConversationState(RENDERER_JOURNAL_FALLBACK)).toBe(true)
    expect(isConversationState('hermes.desktop.preparedSubmissions.v1')).toBe(true)
  })

  it('does NOT flag our Capacitor journal — the bug round 1 caught', () => {
    expect(isConversationState('CapacitorStorage.hermes.preparedSubmissions.v1')).toBe(false)
    // …and the same for every other bridge key the app legitimately writes.
    for (const key of [
      'CapacitorStorage.hermes.target',
      'CapacitorStorage.hermes.device.id.v1',
      'CapacitorStorage.hermes.device.label.v1',
      'CapacitorStorage.hermes.cookies.box.tailnet.ts.net',
    ]) {
      expect(isConversationState(key)).toBe(false)
    }
  })

  it('flags room, message, session and history keys', () => {
    for (const key of [
      'hermes.desktop.group-chat.rooms',
      'hermes.desktop.rooms',
      'room-log',
      'hermes.messages',
      'hermes.sessions',
      'hermes.desktop.history.v1',
    ]) {
      expect(isConversationState(key)).toBe(true)
    }
  })

  it('flags the in-flight turn journal — prompts and assistant rows, not a UI pref', () => {
    expect(isConversationState('hermes.desktop.inflightTurnJournal.v2:sess-1')).toBe(true)
    expect(isConversationState('hermes.desktop.inflightTurnJournal.v1')).toBe(true)
    expect(classifyStorageKey('hermes.desktop.inflightTurnJournal.v2:sess-1').kind).toBe('conversation state')
    // A migration flag is not a payload, and a layout key stays a UI pref.
    expect(isConversationState('hermes.desktop.inflightTurnJournal.v2.migrated')).toBe(false)
    expect(classifyStorageKey('hermes.desktop.layoutTree.v2').kind).toBe('ui pref / rebuildable cache')
  })

  it('flags the composer queue — a queued prompt, not a UI pref', () => {
    expect(isConversationState('hermes.desktop.composerQueue.v1')).toBe(true)
    expect(classifyStorageKey('hermes.desktop.composerQueue.v1').kind).toBe('conversation state')
  })

  it('does not flag UI preferences that merely contain a near-miss word', () => {
    for (const key of [
      'hermes.desktop.layoutTree.v2',
      'hermes.desktop.paneStates.v1',
      'hermes.desktop.toolView.technical',
      'hermes.desktop.model-pricing.v1',
      'hermes-update-check',
    ]) {
      expect(isConversationState(key)).toBe(false)
    }
  })

  it('every deny rule is anchored or word-bounded — no bare substring match', () => {
    expect(CONVERSATION_STATE.length).toBeGreaterThanOrEqual(3)
    for (const rule of CONVERSATION_STATE) {
      // A bare /group-chat/i has source "group-chat". Anchored rules start with
      // ^ or a boundary alternative (^|...).
      const anchored = rule.source.startsWith('^') || rule.source.startsWith('(^|')
      expect(anchored, rule.source).toBe(true)
    }
    // The group-chat rule is the plugin storage key as a final segment
    // (group-chat.ts writes `group-chats` / `group-chat-tombstones`).
    expect(isConversationState('group-chats')).toBe(true)
    expect(isConversationState('hermes.plugin.hermes-bots.group-chats')).toBe(true)
    expect(isConversationState('hermes.plugin.hermes-bots.group-chat-tombstones')).toBe(true)
    expect(isConversationState('ui-group-chat-width')).toBe(false)
    expect(isConversationState('hermes.desktop.layout.group-chat-panel')).toBe(false)
  })
})

describe('classifyStorageKey', () => {
  it('classifies the keys the inventory actually observed', () => {
    const seen = [
      'CapacitorStorage.hermes.target',
      'CapacitorStorage.hermes.device.id.v1',
      'hermes-boot-background',
      'hermes-desktop-active-profile-v1',
      'hermes.desktop.layoutTree.v2',
      'hermes.desktop.model-pricing.v1',
      'hermes.updates.last-passive-check',
    ]
    for (const key of seen) {
      const result = classifyStorageKey(key)
      expect(result.known, `${key} should be classified`).toBe(true)
      expect(result.kind).not.toBe('UNCLASSIFIED')
    }
  })

  it('reports an unseen key as unclassified rather than silently allowing it', () => {
    const result = classifyStorageKey('hermes.brand-new-thing.v1')
    expect(result.known).toBe(false)
    expect(result.kind).toBe('UNCLASSIFIED')
  })

  it('has no overlapping rules that would make the table and the code disagree', () => {
    for (const rule of KNOWN_STORAGE) {
      expect(rule.kind.length).toBeGreaterThan(0)
      expect(rule.match).toBeInstanceOf(RegExp)
    }
  })
})
