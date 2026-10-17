/**
 * stale-alerts.ts — drop the "connection lost" toast the suppressed dial ladder
 * raises while the app is hidden (HM-32).
 *
 * `connection.ts` gates the dial while `isSuspended()`, so every ladder step
 * taken in the background is a *failed* attempt by construction. The vendored
 * boot hook escalates after `RECONNECT_ESCALATE_AFTER_MS` (300 s) with
 * `notify({ durationMs: 0 })` — and `notifications.ts` sets a timer only when
 * `durationMs > 0`, so that toast never expires, and nothing on the reconnect
 * path dismisses it. Resume reconnects in milliseconds, so the user comes back
 * to "Hermes lost its connection" over a socket that is already open.
 *
 * This module owns the matching rule only: which alerts were raised while the
 * app was hidden. `mobile-behaviors.tsx` calls it on the resume edge and
 * dismisses what it returns. If the gateway is genuinely down, the ladder
 * escalates again ~300 s after resume, so nothing real is lost.
 */

/** The fields this rule reads from an `AppNotification`. */
export interface AlertLike {
  id: string
  title?: string
  createdAt: number
}

/**
 * Ids of connection-lost alerts created at or after `hiddenAtMs` (epoch ms).
 * `connectionLostTitle` is the localized copy the escalation uses, so a
 * translated build matches too.
 */
export function staleConnectionLostIds(
  alerts: readonly AlertLike[],
  connectionLostTitle: string,
  hiddenAtMs: number,
): string[] {
  return alerts
    .filter((alert) => alert.createdAt >= hiddenAtMs && alert.title === connectionLostTitle)
    .map((alert) => alert.id)
}
