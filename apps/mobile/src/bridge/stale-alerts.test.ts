import { describe, expect, it } from 'vitest'

import { staleConnectionLostIds } from './stale-alerts'

const LOST = 'Hermes lost its connection'

/** Minimal stand-ins for `AppNotification`. */
const alert = (id: string, createdAt: number, title?: string) => ({ id, createdAt, title })

describe('staleConnectionLostIds (HM-32 escalation toast)', () => {
  it('returns only connection-lost alerts raised at or after the background edge', () => {
    const hiddenSince = 1_000
    const ids = staleConnectionLostIds(
      [
        alert('foreground', 900, LOST), // already on screen before we left: keep it
        alert('hidden-lost', 2_000, LOST),
        alert('hidden-other', 2_500, 'Something else'),
      ],
      LOST,
      hiddenSince,
    )
    expect(ids).toEqual(['hidden-lost'])
  })

  it('matches the localized title, not the English copy', () => {
    const translated = 'Verbindung zum Gateway verloren'
    expect(staleConnectionLostIds([alert('a', 1_000, translated)], translated, 1_000)).toEqual(['a'])
    expect(staleConnectionLostIds([alert('a', 1_000, translated)], LOST, 1_000)).toEqual([])
  })

  it('returns nothing for a short trip to the background', () => {
    expect(staleConnectionLostIds([alert('x', 1_000, LOST)], LOST, 5_000)).toEqual([])
  })
})
