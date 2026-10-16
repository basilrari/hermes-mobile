# hermes-mobile: continuity plan (Option D, the gateway is the source of truth)

Status: **approved by Basil**. Issues are tracked on GitHub (`basilrari/hermes-mobile`). No due dates: start now, finish as fast as possible.
Prepared by Hermes Mobile (lead).
Repos read: `basilrari/hermes-mobile` @ `463330d` (v0.1.1, renderer pinned to upstream `7bda2a33`) and
`NousResearch/hermes-agent` main @ `acc3cada` (167 commits past `7bda2a33` when read).

Related files: [`issues.json`](issues.json) / [`issues.md`](issues.md) (33 issues), [`overview.html`](overview.html) (one-page summary).

---

## 1. Goal

Telegram-style continuity between Hermes Desktop and the Android app (tablet first):

- The same **chats** (single-bot sessions), **group rooms** and **bot-to-bot threads** on Desktop and the app, live and fully synced.
- **Read state** is shared: read on one device means read everywhere.
- **Pick up mid-conversation** on any device, including a room that is running right now.
- **No running Desktop is needed.** `hermes dashboard` on pavillion-claw, reached at `https://pavillion-claw.tailfc1337.ts.net` via `tailscale serve`, does all of it.

Android only. Telegram (`hermes gateway`) stays separate and does not need to sync with Desktop or the app.

"Done" for a milestone means two things: the automated checks pass on the box (headless Chrome at phone and tablet sizes against pavillion-claw, plus unit and gateway tests), and Basil has ticked that milestone's short tablet checklist (about 5 minutes).

## 2. Chosen direction (Option D) and what it means in practice

| Rule | Consequence |
|---|---|
| The gateway is the only source of truth | Rooms are **gateway-hosted rooms** (`groups.*` JSON-RPC over `/api/ws`, stored in the root `shared-state.db`, driven by `gateway/hosted_room_driver.py` via `tui_gateway/hosted_room_service.py`). Sessions live in each profile's `state.db`. |
| The app speaks gateway RPC only | No conversation state in WebView `localStorage`. The app never creates device-local rooms. Basil has 3 bots and no existing rooms, so nothing needs migrating. |
| Bot-to-bot goes through the backend inbox on the one gateway | `message_agent` → durable delivery records under `<profile>/runtime/bot_live_delivery/` (code: `tools/bot_live_delivery.py`, admission in `gateway/session_bot.py`). Headless installs need the two markers (section 4.3). No Desktop relay, no `hermes peer`, no second machine. |
| Gaps are filled with small upstream PRs | Tied to #95163 (hosted rooms) and #126725 (cross-surface sync). Until they merge, pavillion-claw runs a patched hermes-agent branch (approved). PRs go to NousResearch/hermes-agent from `basilrari`; Basil approves each title and body first. |

## 3. Verified against the code (and corrections to the brief)

Checked cheaply against upstream `acc3cada` and hermes-mobile `463330d`. File references are upstream paths unless marked.

| Claim | Result |
|---|---|
| `groups.*` methods in `tui_gateway/methods_groups.py` | **Confirmed.** 18 methods: `capabilities, list, create, state, send, rename, log, disband, replicate, replica_state, promote, demote, stop, retry, approve, peer.invite, peer.revoke, peer.register`. `groups.capabilities` returns `driver`, `protocol_version`, `features`, `methods`, `room_link`, `max_log_limit` (500). |
| Renderer uses canonical rooms when `driver === true` | **Confirmed** (`canonical-group-capabilities.ts`, `groupExecutionMode`). Otherwise `legacy` or `unavailable`. |
| Room log is durable with monotonic seq | **Confirmed.** `gateway/hosted_rooms.append_event` allocates a per-room `seq` in one SQLite transaction; `read_events(since_seq, limit)` is the delta read. **Rooms already survive a gateway restart.** |
| There is no room push | **Confirmed.** No `groups.event` / `groups.changed` anywhere. The renderer **polls every 2 s** while a room is visible, and each poll calls `groups.state` and then re-reads the **whole log from `since_seq: 0`** (`canonical-group-workspace.tsx`, `refresh()`). That is costly on a phone (battery, data). Fixing it is worth an upstream renderer PR, not only a gateway PR. |
| `sessions.changed` broadcasts | **Confirmed** (`tui_gateway/change_watcher.py`, coalesced to at most one per 2 s; the signature includes `last_read_at`, so read-state changes are already pushed for sessions). Broadcast helper: `_broadcast_global_event` in `tui_gateway/server.py`. |
| In-memory replay buffer | **Confirmed** (`tui_gateway/event_replay.py`: 512 events / 4 MiB per session, 64 sessions; `session.events.since` returns `epoch`, `truncated`, `open_requests`). A restart changes the epoch and the client refetches. Only in-flight streams lose detail; history is in `state.db`. → **Durable replay is the lowest-value gap**; kept as a stretch item (HM-24). |
| Session read state | **Confirmed.** `sessions.last_read_at` watermark, set via `PATCH /api/sessions/{id}` with `unread: true/false` (`hermes_cli/web_routers/sessions.py`). Global, not per device. Rooms have **no** read state at all. |
| Bot-to-bot inbox path is `runtime/bot_live_delivery` | **Partly.** That is the *on-disk directory* under each profile home (per `bot-mode.md`). The code is `tools/bot_live_delivery.py`. |
| Headless markers (bot-mode.md ~198–222) | **Confirmed.** Session titled exactly `Bot Chat` (`hermes -p <bot> chat -c "Bot Chat" --create-if-missing`) and a `ui_meta: { hermes-bots: {} }` block in any profile's `profile.yaml`. No CLI writes the second one. |
| Hosted room service runs under `hermes dashboard` | **Confirmed** (`hermes_cli/web_server_app.py` starts it; `gateway/run_startup.py` also starts one for `hermes gateway`). Basil runs both on pavillion-claw, so both may start a driver on the same `shared-state.db`. Authority-epoch fencing exists; HM-08 and HM-28 check it. |
| **New finding: the Desktop relay runs inside the app** | `plugin.tsx` calls `startBotRelay()` on register. With one connection, `relay.ts` (~L424) sends `bot_relay.roster.sync { agents: [] }` once per sole connection. Because `write_remote_roster` replaces `roster.json` wholesale (#115161), **opening the app can likely wipe the relay roster a Desktop published.** Needs confirming with a gateway log; the fix (HM-11) is cheap either way. |
| **New finding: no durable send journal on mobile** | `canonical-group-send.ts` (and the session prompt path) use `window.hermesDesktop.preparedSubmissions` when present, else fall back to `localStorage` ("reload recovery, not process-crash safety"). The mobile bridge does not implement it. Android kills background WebViews often, so this matters (HM-12). |
| Upstream issue status | #95163 and #126725 are open, both labelled `needs-decision` (P3). Upstream PRs may wait a long time. Plan for that (risk R1). |

## 4. How it works (target architecture)

```
 Desktop (Electron)          Android app (tablet)
        │ /api/ws JSON-RPC        │ /api/ws JSON-RPC (WSS only)
        └───────────────┬─────────┘
                        ▼
  pavillion-claw: hermes dashboard  (https://pavillion-claw.tailfc1337.ts.net, tailscale serve, password login)
    ├─ sessions: <profile>/state.db  ── sessions.changed, session.events.since, last_read_at
    ├─ rooms:    shared-state.db     ── groups.* (+ NEW groups.event, groups.read)
    ├─ hosted room driver (runs rounds with no client attached)
    └─ bot inbox: <profile>/runtime/bot_live_delivery (message_agent)

  Same machine, separate: hermes gateway (Telegram). Shares the home and shared-state.db; not synced with the app.
```

### 4.1 Data flows
- **Open a room:** `groups.list` → `groups.state` → `groups.log` from the device's last seen seq (not from 0).
- **Live updates:** gateway pushes `groups.event {room_id, latest_seq}` over the open WS (hint only); the client fetches `groups.log since_seq`. Polling stays as a slow fallback when the gateway lacks the feature.
- **Send:** `groups.send` with a client `event_id` (idempotent). The pending send is journalled durably on the device (HM-12) so a killed app re-sends the same id.
- **Read:** one user-level watermark per room. `groups.read {room_id, seq}` moves it forward; a `groups.event {kind: "read"}` tells other clients to clear badges. Sessions keep using `PATCH unread:false` + `sessions.changed`.
- **Resume:** on app resume or network change: new WS ticket, reconnect, `session.events.since` (reset on epoch change), `groups.log since_seq` per open room.
- **Background:** the app closes the WS and stops polling when backgrounded (HM-32). There are no push notifications; it catches up on resume.

### 4.2 Device identity
A random `device_id` (UUID, in Capacitor Preferences) plus a label. Used only for per-device resume position (HM-22/25, low priority), never for read state. Not a secret, never from hardware IDs.

### 4.3 One-time gateway setup (pavillion-claw)
1. `hermes dashboard` reachable only through `tailscale serve` at `https://pavillion-claw.tailfc1337.ts.net`, password login on. The app refuses `http://` URLs and has cleartext off (HM-02).
2. Per bot (3 bots): `hermes -p <bot> chat -c "Bot Chat" --create-if-missing` once.
3. One profile's `profile.yaml`: `ui_meta: { hermes-bots: {} }` (the app's New Bot already writes this).
4. `groups.capabilities` must report `driver: true`, with exactly one process holding the room driver authority. The doctor (HM-08) checks all of this read-only.
5. Patched hermes-agent branch installed with a one-command rollback (HM-18).

### 4.4 App identity
App ID is `io.github.basilrari.hermesmobile` (HM-01, first issue). Android sees an ID change as a new app, so Basil uninstalls the previous APK and logs in again once.

## 5. Team, tracks and interfaces

| Role | Owns | Does not touch |
|---|---|---|
| **Hermes Mobile (lead)** | Splits work, writes acceptance criteria, adversarial review of every PR, runs milestone gates, writes Basil's tablet checklists, keeps this plan current. Writes no code. | Code |
| **Eng A: app / bridge / Android** | `apps/mobile/**`, Android project, mobile-only overrides, renderer resync commits, headless harness, repo hygiene/CI, docs in hermes-mobile. | Upstream `hermes-agent` code (only consumes it) |
| **Eng B: gateway / upstream** | Upstream PRs to `hermes-agent` (gateway **and** the `apps/desktop` renderer side of the same protocol), the patched branch on pavillion-claw, doctor, gateway-side tests and soak. | `apps/mobile/**` |

**Why the renderer side goes to Eng B:** a protocol change and its reference client should land in one upstream review. Eng A picks up the result through a renderer resync (or a carried patch until merge). Eng A never edits `apps/desktop/**` except via the resync/patch mechanism (HM-16).

### 5.1 Interfaces (frozen at gate G0, HM-10)
1. **`groups.event`**: server→client frame `{room_id, latest_seq, kind: "log"|"state"|"read", epoch}`; hint only. Feature `event_push`.
2. **`groups.read`**: `{room_id, seq, device_id?}` → `{read_seq}`; `groups.list`/`groups.state` gain `read_seq`, `unread_count`. Feature `read_cursors`. Global, not per device.
3. **Per-device resume cursors** (P2): `device_id`, label, `last_seen_at`, per-conversation `last_seen_seq`. Feature `device_cursors`.
4. **Bridge**: `window.hermesDesktop.preparedSubmissions {read, compareAndSet}` (existing Desktop contract) and a new optional `deviceIdentity()`.
5. **Feature detection everywhere**: the app keeps working (with polling) against a stock gateway.

### 5.2 Review gates
| Gate | When | Pass rule |
|---|---|---|
| **G0 Contract** | Before any M2 code | Lead approves HM-10 contracts; Basil sees them in the overview. |
| **G1 PR review** | Every PR | Lead's adversarial checklist: scope = one issue; tests added and passing; no secrets (gitleaks clean); no `apps/desktop/**` edits outside HM-16's mechanism; feature-detected; failure modes named; harness screenshots for UI. Two rounds max, then lead escalates to Basil. |
| **G2 Milestone** | Closing a milestone | Headless harness green at phone and tablet sizes against pavillion-claw; unit and gateway tests green; Basil's tablet checklist ticked (≈5 min, screenshots where asked); APK version + commit. Stored in `docs/VERIFICATION.md`. |
| **G3 Upstream** | Before opening an upstream PR | Lead review passed; Basil approves the title and body. Opened from `basilrari` to NousResearch/hermes-agent. |

## 6. Phases, timeline and milestones

No due dates. Work starts now and runs as fast as the gates allow; milestones close in order (M0 → M4), each when its G2 gate passes. App and upstream work run in parallel. **Upstream merge timing is not ours to control**, so M2/M3 are verified on pavillion-claw running the patched branch.

| Order | Eng A (app) | Eng B (gateway/upstream) | Gate to close |
|---|---|---|---|
| M0 | App ID, HTTPS only, device bring-up, harness, first real reply, trace, secrets guard | Doctor, setup guide, **contracts (G0)** | G2 + G0 |
| M1 | Resync, relay off, send journal, storage audit, gateway rooms only, resume | Patched branch + rollback, bot-to-bot via backend inbox; start `groups.event` | G2 |
| M2 | Integrate live sync + read state on carried patches | `groups.event`, incremental log, read cursors, unread badges, resume cursors (P2) | G2 |
| M3 | Continuity matrix | Restart/soak | G2 |
| M4 | Tablet polish, phone-size harness pass, background behaviour | Upstream follow-through, patch rebase | G2 |

Eng B starts M2 upstream work as soon as G0 passes, without waiting for M1 to close.

### M0 · Baseline on device
**Acceptance:**
- App ID is `io.github.basilrari.hermesmobile`; Basil reinstalled once.
- The app connects only to `https://pavillion-claw.tailfc1337.ts.net` over HTTPS/WSS; `http://` is refused; cleartext off.
- Tablet checklist: install, password login, relaunch keeps the session, Sessions | Bots tabs in both orientations.
- One single-bot chat gets a real streamed reply (DeepSeek Flash) in the harness and on the tablet.
- Harness runs at phone and tablet sizes; doctor report for pavillion-claw attached; RPC trace export works.

### M1 · Gateway-only client
**Acceptance:**
- Harness trace over 10 minutes shows **zero** `bot_relay.*` calls; `bot_relay/roster.json` unchanged after opening the app while Desktop runs.
- Only gateway rooms; a room created in the app shows on Desktop and vice versa; no room content in WebView storage.
- Reload (harness) or force-stop (tablet) mid-send: the pending send is re-sent once (same `event_id`) and appears once.
- Network drop / Tailscale off-on / 10 min backgrounded: app recovers without re-login and shows everything that happened meanwhile.
- Bot A messages bot B via `message_agent` with no Desktop running; the receipt reaches `settled` and both Bot Chats show it.
- Patched branch on pavillion-claw installs and rolls back cleanly.

### M2 · Live sync and read state
**Acceptance:**
- With a room open on Desktop and the app, a message from either side appears on the other in **≤ 2 s (p95 over 20 messages)** with no 2 s full-log polling.
- Against a stock gateway the app still works by polling.
- Reading a room or session in one place clears its unread badge everywhere within 3 s.
- Unread counts survive a gateway restart.

### M3 · Continuity verified, Desktop closed
**Acceptance (Desktop quit unless the scenario says otherwise):**
- Continuity matrix (§7) passes in the harness; tablet checklist passes.
- A room started on Desktop keeps running after Desktop quits; the app picks it up mid-round and can send into it.
- Gateway restart mid-round (each of the two processes): consistent log, no duplicates or gaps.

### M4 · Tablet polish
**Acceptance:**
- Agreed tablet list passes in both orientations (harness screenshots + tablet checklist).
- No obvious breakage at phone size in the harness.
- Backgrounded app makes no requests; catch-up on resume is complete.
- Carried patches rebased on current upstream; doctor green.

## 7. Testing strategy

1. **Unit (Eng A):** vitest for the bridge (`apps/mobile/src/bridge/*.test.ts`; 35 tests today): send journal CAS, device identity, reconnect/epoch logic, relay shim, URL scheme check. `npm run typecheck` clean.
2. **Gateway/upstream unit (Eng B):** pytest next to the existing suites (`tests/tui_gateway/test_groups_methods.py`, `test_change_watcher.py`, `tests/gateway/test_hosted_room_*.py`); vitest for renderer changes next to `canonical-group-*.test.ts`.
3. **Headless harness on the box (HM-06):** built bundle in headless Chrome at phone (412×915) and tablet (1280×800) sizes against `https://pavillion-claw.tailfc1337.ts.net`; two concurrent clients for sync tests; reads the RPC trace. This is the main automated check. The phone is not a test target beyond this.
   - **Continuity matrix:** {Desktop, app at tablet size, app at phone size} × {single-bot chat, room, bot-to-bot thread} × {send, read, resume mid-stream, resume after reload, resume after gateway restart}.
4. **Tablet checklist (Basil, by hand):** about 5 minutes per milestone, written by the lead from that milestone's acceptance. No adb, no bot driving the device.
5. **Soak (Eng B):** 1-hour 3-bot room with no clients; restart each process mid-round; seq continuity, no duplicate sends.
6. **Security:** gitleaks on every PR; APK scanned for secrets before any handoff.
7. **Real LLM turns:** DeepSeek Flash only, $5/month spend cap. Every test issue that makes real turns carries this constraint; the harness counts turns per run.

## 8. Risks and mitigations

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | Upstream PRs sit in `needs-decision` for weeks | High / medium | Small, feature-flagged PRs; carry patches on the pavillion-claw branch and in hermes-mobile (HM-16, HM-18); app feature-detects and falls back to polling. |
| R2 | Upstream churn breaks the pinned renderer or our patches | High / medium | Resync at the start of each milestone, rerun tests + harness; rebase in HM-33. |
| R3 | App relay wipes Desktop's relay roster | Likely / medium | HM-11 first in M1; confirm with gateway log. |
| R4 | Two room drivers (`hermes dashboard` + `hermes gateway`) on one `shared-state.db` on pavillion-claw | Unknown / high | Doctor reports which process holds authority (HM-08); restart soak of each process (HM-28); rely on authority-epoch fencing. |
| R5 | Android kills the WebView/WS in background | High / medium | Durable send journal (HM-12), resume logic (HM-15), clean background close (HM-32). Without push, nothing arrives while the app is closed; that is accepted. |
| R6 | Polling cost until `groups.event` lands | Certain until M2 | HM-20 incremental log + push hint; only poll visible rooms; nothing in background. |
| R7 | Secrets leak (gateway password, DeepSeek key, keystores) | Low / high | Runtime-entered only; gitleaks pre-commit + CI (HM-07); `.gitignore` for keystores and `.env`. |
| R8 | Test inference overspends | Low / low | DeepSeek Flash, $5/month cap, turn counter in the harness. |
| R9 | Prompt injection between bots / runaway loops in rooms | Medium / medium | Upstream round caps; limit dangerous tools on room bots; spend cap. |
| R10 | Renderer must stay "unmodified" but mobile needs a few changes | Certain / low | Generic changes go upstream; mobile-only ones via Vite alias shims in one place (HM-16). |
| R11 | Headless Chrome misses device-only bugs (CapacitorHttp, lifecycle, keyboard) | Medium / medium | Basil's tablet checklist targets exactly those items each milestone. |

## 9. Decisions (answered by Basil)

1. **Device checks:** Basil runs a ≈5-minute checklist by hand on his Android tablet per milestone. Automated checks run on the box (headless Chrome at phone and tablet sizes against pavillion-claw, unit and gateway tests). The phone is not a test target. No adb, no bot driving the device.
2. **Patched gateway:** OK. Upstream PRs go to NousResearch/hermes-agent from `basilrari`; Basil approves each title and body first.
3. **Push notifications:** none. All push work and its risks are removed; M4 is "Tablet polish".
4. **Read state:** read on one device means read everywhere.
5. **Layout:** one machine, pavillion-claw, runs `hermes gateway` and `hermes dashboard`. Telegram stays separate. No second machine, so no `hermes peer` or cross-gateway tests; bot-to-bot goes through the backend inbox.
6. **Rooms:** no existing rooms (3 bots), nothing to migrate. Desktop and the app are fully synced.
7. **Durable replay buffer:** stays a stretch goal (HM-24).
8. **Test inference:** DeepSeek Flash, $5/month cap; stated in every test issue that makes real turns.
9. **App ID:** `io.github.basilrari.hermesmobile` (HM-01); one-time reinstall.
10. **TLS:** HTTPS only via `tailscale serve` at `https://pavillion-claw.tailfc1337.ts.net`; cleartext off (HM-02).
11. **Platforms:** Android only.

## 10. Out of scope

- Google Play publishing, release signing keys, store listings.
- Any secret in a commit, build, or issue (tokens, passwords, keystores).
- iOS; push notifications; Telegram sync with Desktop or the app; official Nous branding.
- `hermes peer`, cross-gateway messaging, a second gateway.
- Fixing the Desktop relay (`relay.ts`, #115161/#139219); we avoid it.
- The full #126725 "Conversation Layer", multi-user/shared-gateway privacy (#122151).
- Rewriting the chat UI; a native (non-WebView) client.
- A2A, Matrix, E2EE beyond Tailscale/WireGuard, exposing the gateway to the internet.

## 11. Issue map

33 issues across 5 milestones (details in `issues.md`):

| Milestone | Eng A (app) | Eng B (gateway/upstream) | Count |
|---|---|---|---|
| M0 Baseline on device | HM-01, 02, 03, 04, 05, 06, 07 | HM-08, 09, 10 | 10 |
| M1 Gateway-only client | HM-11, 12, 13, 14, 15, 16 | HM-17, 18 | 8 |
| M2 Live sync & read state | HM-25, 26 | HM-19, 20, 21, 22, 23, 24 (stretch) | 8 |
| M3 Continuity verified | HM-27, 29 | HM-28 | 3 |
| M4 Tablet polish | HM-30, 31, 32 | HM-33 | 4 |
