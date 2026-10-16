## Summary
<!-- 2-4 bullets: what changed -->

Closes #

## Evidence
<!-- local test run: N passed; journal numbers; before/after -->

## Safety
<!-- defaults: zero behaviour change for live systems (flag off / old
     behaviour preserved)? state it explicitly -->

- [ ] **No conversation state on the device (HM-13).** No new `localStorage`/
      IndexedDB key holds messages, room logs or session history — UI prefs and
      bridge state only. New key ⇒ a row in docs/ARCHITECTURE.md.

## Rollback
<!-- revert commit / config flag to flip back -->
