# hermes-mobile: draft GitHub issues

33 issues. Source of truth: `issues.json` (same content). Plan: `PLAN.md`.

Each issue is sized for roughly one PR. IDs (HM-xx) are stable and used for dependencies until GitHub numbers exist.

## Labels to create

| Label | Color | Description |
|---|---|---|
| `track:app` | #1d76db | Eng A: app, bridge, Android |
| `track:gateway` | #5319e7 | Eng B: gateway and upstream PRs |
| `upstream-pr` | #b60205 | Change lands in NousResearch/hermes-agent (Basil approves title and body first) |
| `type:feature` | #a2eeef | New capability |
| `type:bug` | #d73a4a | Something is wrong |
| `type:test` | #c5def5 | Verification or test work |
| `type:docs` | #0075ca | Documentation |
| `type:chore` | #cfd3d7 | Maintenance |
| `needs-device-verify` | #fbca04 | Not done until Basil ticks the tablet checklist against his gateway |
| `review:gate` | #000000 | Gate: lead (and Basil) must sign off |
| `stretch` | #ededed | Optional; only if the milestone is otherwise done |
| `priority:P0` | #b60205 | Blocks the milestone |
| `priority:P1` | #d93f0b | Needed for the milestone |
| `priority:P2` | #0e8a16 | Nice to have |
| `area:rooms` | #bfdadc | Gateway-hosted group rooms |
| `area:sessions` | #bfdadc | Single-bot sessions |
| `area:bots` | #bfdadc | Bot-to-bot messaging |
| `area:read-state` | #bfdadc | Read cursors and unread |
| `area:protocol` | #bfdadc | RPC contracts |
| `area:tablet` | #bfdadc | Tablet and phone-size layout |
| `area:security` | #bfdadc | Secrets, TLS |
| `area:setup` | #bfdadc | Gateway setup |
| `area:storage` | #bfdadc | Device-side storage |
| `area:renderer` | #bfdadc | Desktop renderer code |
| `area:diagnostics` | #bfdadc | Tracing and logs |
| `area:identity` | #bfdadc | App ID and naming |
| `area:testing` | #bfdadc | Test harness and checklists |

## Milestones to create

| Milestone | Description |
|---|---|
| M0 · Baseline on device | New app ID, HTTPS only, first real reply on the tablet, headless harness, gateway doctor, contracts frozen. |
| M1 · Gateway-only client | App speaks gateway RPC only: relay off, gateway rooms only, durable send journal, resume; bot-to-bot via the backend inbox; patched gateway branch ready. |
| M2 · Live sync & read state | groups.event, incremental logs, shared room read state; verified against the patched gateway. |
| M3 · Continuity verified (no Desktop) | Continuity matrix passes with Desktop closed; restart/soak clean. |
| M4 · Tablet polish | Tablet polish, phone-size check, quiet background behaviour, upstream follow-through. |

## Index

| ID | GitHub | Title | Milestone | Track | Depends on |
|---|---|---|---|---|---|
| HM-01 | #1 | Change the app ID to io.github.basilrari.hermesmobile | M0 | A | – |
| HM-02 | #2 | HTTPS only via tailscale serve (https://pavillion-claw.tailfc1337.ts.net); cleartext off | M0 | A | HM-01 |
| HM-03 | #3 | Install the renamed debug APK on Basil's tablet and log in | M0 | A | HM-01, HM-02 |
| HM-04 | #4 | First real chat turn: a single-bot session streams an LLM reply | M0 | A | HM-03, HM-06 |
| HM-05 | #5 | Debug-only RPC trace: log method names and timing, export from the app | M0 | A | – |
| HM-06 | #6 | Headless test harness on the box: phone and tablet viewports against pavillion-claw | M0 | A | HM-02 |
| HM-07 | #7 | Secrets guard: gitleaks pre-commit and CI, ignore rules for keystores | M0 | A | – |
| HM-08 | #8 | Read-only gateway doctor for pavillion-claw | M0 | B | – |
| HM-09 | #9 | Gateway setup guide for pavillion-claw | M0 | B | HM-08 |
| HM-10 | #10 | Write and freeze the protocol contracts (gate G0) | M0 | B | – |
| HM-11 | #11 | Stop the Desktop bot relay from running inside the mobile app | M1 | A | HM-05, HM-16 |
| HM-12 | #12 | Implement `preparedSubmissions` in the bridge so pending sends survive app kills | M1 | A | HM-16 |
| HM-13 | #13 | Inventory renderer-local storage on mobile; keep only UI prefs on the device | M1 | A | HM-05, HM-06 |
| HM-14 | #14 | Gateway rooms only: remove the device-local room create path on mobile | M1 | A | HM-13, HM-16 |
| HM-15 | #15 | Resume and reconnect: app lifecycle, network changes, replay epoch | M1 | A | HM-04 |
| HM-16 | #16 | Resync the renderer to upstream main and add an override/carry-patch mechanism | M1 | A | – |
| HM-17 | #17 | Verify bot-to-bot through the backend inbox with no Desktop running | M1 | B | HM-09 |
| HM-18 | #18 | Patched hermes-agent branch on pavillion-claw: deploy, rollback, upstream PR flow | M1 | B | HM-08, HM-09 |
| HM-19 | #19 | Upstream PR: `groups.event` push for hosted rooms | M2 | B | HM-10, HM-18 |
| HM-20 | #20 | Upstream PR: renderer uses `groups.event` and incremental `groups.log` | M2 | B | HM-19 |
| HM-21 | #21 | Upstream PR: room read cursors (`groups.read`, `read_seq`, `unread_count`) | M2 | B | HM-10, HM-19 |
| HM-22 | #22 | Upstream PR: per-device resume cursors | M2 | B | HM-21 |
| HM-23 | #23 | Upstream PR: renderer unread badges and mark-read for gateway rooms | M2 | B | HM-20, HM-21 |
| HM-24 | #24 | Upstream PR (stretch): durable session replay buffer | M2 | B | HM-10 |
| HM-25 | #25 | Device identity in the bridge (`deviceIdentity()`) | M2 | A | HM-10 |
| HM-26 | #26 | Integrate live sync and read state in the app | M2 | A | HM-16, HM-20, HM-23 |
| HM-27 | #27 | Continuity matrix with Desktop closed | M3 | A | HM-26, HM-17, HM-15 |
| HM-28 | #28 | Gateway restart and 1-hour soak on pavillion-claw (two processes, one home) | M3 | B | HM-19, HM-21 |
| HM-29 | #29 | Update ARCHITECTURE.md and VERIFICATION.md for Option D | M3 | A | HM-27 |
| HM-30 | #30 | Tablet layout polish | M4 | A | HM-27 |
| HM-31 | #31 | Phone-size layout pass in the harness | M4 | A | HM-30 |
| HM-32 | #32 | Background behaviour: close the socket and stop polling when backgrounded | M4 | A | HM-15 |
| HM-33 | #33 | Upstream follow-through: review responses and patch rebase | M4 | B | HM-18, HM-19, HM-21 |

## M0 · Baseline on device

### [HM-01] Change the app ID to io.github.basilrari.hermesmobile

Labels: `track:app`, `type:chore`, `area:identity`, `needs-device-verify`, `priority:P0` · Assignee role: eng-a

**ID:** HM-01 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M0 · Baseline on device

#### Context
The previous app ID looked official. Basil chose `io.github.basilrari.hermesmobile`. Android treats a new ID as a new app, so this is done first and costs a **one-time reinstall** (uninstall the old APK, install the new one, log in again).

#### Tasks
- [ ] Set `appId` in `capacitor.config.ts`; update `applicationId`/`namespace` in the Android Gradle files and move the Java/Kotlin package (`MainActivity`) to match.
- [ ] Grep the repo for the old ID (README, docs, scripts, tests) and update every reference.
- [ ] Keep the display name decision visible in the PR (name stays "Hermes" unless Basil says otherwise).
- [ ] README: note the one-time reinstall and that old app data is not carried over.

#### Acceptance criteria
- [ ] `apksigner`/`aapt dump badging` shows package `io.github.basilrari.hermesmobile`.
- [ ] No occurrence of the old ID left in the repo.
- [ ] Reinstall step written in README.
- [ ] Basil ticks the milestone's device checklist on his Android tablet against pavillion-claw (about 5 minutes; screenshots where the checklist asks). No adb, no bot driving the device.

#### Files
- `apps/mobile/capacitor.config.ts`
- `apps/mobile/android/app/build.gradle`
- `apps/mobile/android/app/src/main/java/** (package move)`
- `README.md`

#### Dependencies
- None

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-02] HTTPS only via tailscale serve (https://pavillion-claw.tailfc1337.ts.net); cleartext off

Labels: `track:app`, `type:feature`, `area:security`, `needs-device-verify`, `priority:P0` · Assignee role: eng-a

**ID:** HM-02 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M0 · Baseline on device

#### Context
Decision: the gateway is reached only at `https://pavillion-claw.tailfc1337.ts.net` through `tailscale serve`. Today the app origin is `http://localhost` with cleartext allowed so `ws://` works (`capacitor.config.ts`, `network_security_config.xml`). LAN `http://` stops working; that is intended.

#### Tasks
- [ ] Set `androidScheme: 'https'`; set `cleartextTrafficPermitted="false"` in `network_security_config.xml` and remove any cleartext domain exceptions.
- [ ] Reject `http://` and `ws://` gateway URLs in the connect screen with a clear message.
- [ ] Confirm the WSS + `/api/auth/ws-ticket` flow against the ts.net URL.
- [ ] Update README security notes.

#### Acceptance criteria
- [ ] Login, chat and rooms work over HTTPS/WSS.
- [ ] An `http://` URL is refused by the app and by Android policy (unit test for the URL check).
- [ ] Automated check passes on the box: built bundle in headless Chrome at phone (412×915) and tablet (1280×800) sizes against https://pavillion-claw.tailfc1337.ts.net.
- [ ] Basil ticks the milestone's device checklist on his Android tablet against pavillion-claw (about 5 minutes; screenshots where the checklist asks). No adb, no bot driving the device.

#### Files
- `apps/mobile/capacitor.config.ts`
- `apps/mobile/android/app/src/main/res/xml/network_security_config.xml`
- `apps/mobile/src/mobile/ (connect screen)`
- `README.md`

#### Dependencies
- HM-01 (new app ID)

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-03] Install the renamed debug APK on Basil's tablet and log in

Labels: `track:app`, `type:test`, `needs-device-verify`, `priority:P0` · Assignee role: eng-a

**ID:** HM-03 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M0 · Baseline on device

#### Context
v0.1.1 was only tested in headless Chrome and never on a physical device (`docs/VERIFICATION.md`). This is the first device run, with the new ID and HTTPS-only build.

#### Tasks
- [ ] Build `app-debug.apk`; record versionName/versionCode and commit.
- [ ] Write the M0 device checklist (≤ 5 minutes) for Basil: uninstall old app, install, connect to the ts.net URL, log in, relaunch keeps session, Sessions | Bots tabs in both orientations, Bots roster lists the 3 bots.
- [ ] Record Basil's results in `docs/VERIFICATION.md`; file each defect as a new issue.

#### Acceptance criteria
- [ ] Login works through the native HTTP path (CapacitorHttp).
- [ ] Relaunch does not ask for the password again.
- [ ] Basil ticks the milestone's device checklist on his Android tablet against pavillion-claw (about 5 minutes; screenshots where the checklist asks). No adb, no bot driving the device.

#### Files
- `apps/mobile/src/bridge/auth.ts`
- `apps/mobile/src/bridge/cookie-jar.ts`
- `docs/VERIFICATION.md`
- `docs/checklists/M0.md (new)`

#### Dependencies
- HM-01
- HM-02

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-04] First real chat turn: a single-bot session streams an LLM reply

Labels: `track:app`, `type:test`, `area:sessions`, `needs-device-verify`, `priority:P0` · Assignee role: eng-a

**ID:** HM-04 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M0 · Baseline on device

#### Context
No real reply has ever been tested (the test gateway had no inference provider). Constraint: real LLM turns use DeepSeek Flash only, within the $5/month test spend cap; keep prompts short and record the turns used.

#### Tasks
- [ ] Headless: send a prompt in a normal session and in a bot's `Bot Chat` at both viewport sizes; check streaming, tool calls, final message.
- [ ] Headless: background the page (visibility hidden) for 30 s mid-stream; note whether it resumes (`session.events.since`) or refetches.
- [ ] Device checklist item: Basil sends one prompt on the tablet and sees the same transcript on Desktop.

#### Acceptance criteria
- [ ] Streamed reply renders fully in a session and a Bot Chat.
- [ ] Behaviour after backgrounding written down.
- [ ] Constraint: real LLM turns use DeepSeek Flash only, within the $5/month test spend cap; keep prompts short and record the turns used.
- [ ] Automated check passes on the box: built bundle in headless Chrome at phone (412×915) and tablet (1280×800) sizes against https://pavillion-claw.tailfc1337.ts.net.
- [ ] Basil ticks the milestone's device checklist on his Android tablet against pavillion-claw (about 5 minutes; screenshots where the checklist asks). No adb, no bot driving the device.

#### Files
- `apps/mobile/src/bridge/connection.ts`
- `docs/VERIFICATION.md`

#### Dependencies
- HM-03 (device bring-up)
- HM-06 (harness)

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-05] Debug-only RPC trace: log method names and timing, export from the app

Labels: `track:app`, `type:feature`, `area:diagnostics`, `priority:P1` · Assignee role: eng-a

**ID:** HM-05 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M0 · Baseline on device

#### Context
We need proof that the app speaks gateway RPC only, never calls `bot_relay.*`, and stops full-log polling after M2. The headless harness reads it directly; on the tablet Basil can share it from a hidden screen when a checklist item fails.

#### Tasks
- [ ] Wrap the bridge's WS/REST send paths to record `{t, direction, method or path, ms, ok}`; never record params, bodies, cookies or tickets.
- [ ] Ring buffer (last 2,000 entries); long-press on the version label to share as a text file; expose to the harness via a debug global.
- [ ] Hide in non-debug builds.
- [ ] Unit tests: no secret-looking fields can enter the record.

#### Acceptance criteria
- [ ] A 10-minute trace can be exported.
- [ ] A test proves params/headers are never stored.
- [ ] Trace includes server-pushed event names (e.g. `sessions.changed`).

#### Files
- `apps/mobile/src/bridge/http.ts`
- `apps/mobile/src/bridge/connection.ts`
- `apps/mobile/src/mobile/ (debug screen)`

#### Dependencies
- None

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-06] Headless test harness on the box: phone and tablet viewports against pavillion-claw

Labels: `track:app`, `type:test`, `area:testing`, `priority:P0` · Assignee role: eng-a

**ID:** HM-06 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M0 · Baseline on device

#### Context
Automated checks run on the box, not on a device: the built bundle in headless Chrome at phone and tablet sizes against `https://pavillion-claw.tailfc1337.ts.net`, plus unit and gateway tests. The phone is not a test target. Basil runs a short manual checklist on the tablet per milestone. Constraint: real LLM turns use DeepSeek Flash only, within the $5/month test spend cap; keep prompts short and record the turns used.

#### Tasks
- [ ] Script (Playwright or Puppeteer) that serves the built bundle, logs in with the password from an env var, and runs scenario files.
- [ ] Two viewport profiles: phone 412×915, tablet 1280×800 (portrait and landscape).
- [ ] Support two concurrent clients (for sync tests later) and reading the RPC trace (HM-05).
- [ ] `docs/checklists/` template: each milestone's tablet checklist must fit in about 5 minutes.
- [ ] Turn counter: fail the run if it would exceed the per-run turn budget.

#### Acceptance criteria
- [ ] `npm run e2e` passes login + Bots roster at both sizes.
- [ ] No credential in output or artefacts.
- [ ] Constraint: real LLM turns use DeepSeek Flash only, within the $5/month test spend cap; keep prompts short and record the turns used.

#### Files
- `scripts/e2e/ (new)`
- `docs/checklists/ (new)`
- `package.json`

#### Dependencies
- HM-02 (HTTPS build)

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-07] Secrets guard: gitleaks pre-commit and CI, ignore rules for keystores

Labels: `track:app`, `type:chore`, `area:security`, `priority:P0` · Assignee role: eng-a

**ID:** HM-07 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M0 · Baseline on device

#### Context
Secrets must never land in a commit: gateway password, DeepSeek key, keystores.

#### Tasks
- [ ] Add gitleaks config + pre-commit instructions; a CI job (no secrets needed) running gitleaks, `npm test`, `npm run typecheck`.
- [ ] `.gitignore`: `*.jks`, `*.keystore`, `.env*`, `local.properties`, `release/*.apk` policy.
- [ ] Scan current history once and report (do not rewrite history without Basil).

#### Acceptance criteria
- [ ] CI fails on a planted fake secret in a test branch.
- [ ] History scan result recorded in the PR.

#### Files
- `.github/workflows/ci.yml (new)`
- `.gitleaks.toml (new)`
- `.gitignore`

#### Dependencies
- None

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-08] Read-only gateway doctor for pavillion-claw

Labels: `track:gateway`, `type:feature`, `area:setup`, `priority:P0` · Assignee role: eng-b

**ID:** HM-08 · **Track:** Eng B (gateway/upstream) · **Milestone:** M0 · Baseline on device

#### Context
pavillion-claw runs both `hermes gateway` (Telegram) and `hermes dashboard` on one home. Continuity needs the hosted room driver, headless Bot Mode markers, and one healthy driver on `shared-state.db`.

#### Tasks
- [ ] Script under `scripts/gateway-doctor/` (runs on pavillion-claw; reads `~/.hermes`, calls RPC with a password from an env var, never writes).
- [ ] Checks: `/api/status`; `groups.capabilities` (`driver`, `protocol_version`, `features`); a `Bot Chat` session for each of the 3 bots; a `profile.yaml` with `ui_meta.hermes-bots`; both processes present and which one holds the room driver authority epoch; tailscale serve URL answers over HTTPS.
- [ ] Pass/warn/fail table; non-zero exit on fail.

#### Acceptance criteria
- [ ] Report from pavillion-claw attached to M0 evidence.
- [ ] Provably no writes (read-only DB opens).
- [ ] No credential in output.

#### Files
- `scripts/gateway-doctor/ (new)`
- `Reads: ~/.hermes/profiles/*/profile.yaml, ~/.hermes/config.yaml, <profile>/state.db (read-only)`

#### Dependencies
- None

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-09] Gateway setup guide for pavillion-claw

Labels: `track:gateway`, `type:docs`, `area:setup`, `priority:P1` · Assignee role: eng-b

**ID:** HM-09 · **Track:** Eng B (gateway/upstream) · **Milestone:** M0 · Baseline on device

#### Context
One machine runs `hermes gateway` and `hermes dashboard`. Telegram is separate and does not sync with Desktop or the app. `bot-mode.md` (~L198–222): `message_agent` needs a `Bot Chat` session and `ui_meta: { hermes-bots: {} }`, and no CLI writes the latter.

#### Tasks
- [ ] Write `docs/GATEWAY_SETUP.md`: `tailscale serve` for `https://pavillion-claw.tailfc1337.ts.net`, password login, markers (exact commands/YAML), driver check, the two-process layout and what each owns.
- [ ] Link the doctor (HM-08) and the patched-branch runbook (HM-18).

#### Acceptance criteria
- [ ] Basil can follow it without questions (lead dry-reads it).
- [ ] Every command cites its upstream source.

#### Files
- `docs/GATEWAY_SETUP.md (new)`

#### Dependencies
- HM-08 (doctor)

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-10] Write and freeze the protocol contracts (gate G0)

Labels: `track:gateway`, `type:docs`, `area:protocol`, `review:gate`, `priority:P0` · Assignee role: eng-b

**ID:** HM-10 · **Track:** Eng B (gateway/upstream) · **Milestone:** M0 · Baseline on device

#### Context
Both tracks need fixed interfaces before M2 code: `groups.event`, `groups.read` (read anywhere = read everywhere), device identity and per-device resume cursors, bridge additions. Feature flags in `groups.capabilities.features` keep the app working on a stock gateway.

#### Tasks
- [ ] Write `planning/contracts/`: `groups-event.md`, `read-cursors.md`, `device-identity.md`, `bridge-additions.md`.
- [ ] For each: wire shape, errors, feature flag, ordering/duplication rules, restart behaviour (epoch), and the dashboard-vs-gateway process note.
- [ ] Ground each in existing code: `_broadcast_global_event`, `change_watcher.py`, `hosted_rooms.append_event/read_events`, `sessions.last_read_at`.
- [ ] Lead approval; summarise in `overview.html`.

#### Acceptance criteria
- [ ] Lead signs off (G0) before HM-19/21/22/25 start.
- [ ] Every new method/field is feature-detectable.

#### Files
- `planning/contracts/*.md (new)`

#### Dependencies
- None

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

## M1 · Gateway-only client

### [HM-11] Stop the Desktop bot relay from running inside the mobile app

Labels: `track:app`, `type:bug`, `area:rooms`, `priority:P0` · Assignee role: eng-a

**ID:** HM-11 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M1 · Gateway-only client

#### Context
`plugin.tsx` calls `startBotRelay()` on register; with one connection `relay.ts` (~L424) sends `bot_relay.roster.sync { agents: [] }`, and `write_remote_roster` replaces `roster.json` wholesale (#115161). Option D doesn't use the relay.

#### Tasks
- [ ] Confirm with the trace (HM-05) and a gateway log.
- [ ] Disable on mobile without editing `apps/desktop/**`: Vite alias shim exporting no-op `startBotRelay/stopBotRelay`, via HM-16.
- [ ] Unit test: plugin register path never calls `bot_relay.*`.

#### Acceptance criteria
- [ ] Harness trace over 10 minutes shows zero `bot_relay.*` calls.
- [ ] `~/.hermes/bot_relay/roster.json` unchanged after app launch while Desktop runs.
- [ ] Automated check passes on the box: built bundle in headless Chrome at phone (412×915) and tablet (1280×800) sizes against https://pavillion-claw.tailfc1337.ts.net.

#### Files
- `apps/mobile/vite.config.ts`
- `apps/mobile/src/overrides/relay.ts (new)`

#### Dependencies
- HM-05 (trace)
- HM-16 (override mechanism)

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-12] Implement `preparedSubmissions` in the bridge so pending sends survive app kills

Labels: `track:app`, `type:feature`, `area:rooms`, `area:sessions`, `needs-device-verify`, `priority:P0` · Assignee role: eng-a

**ID:** HM-12 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M1 · Gateway-only client

#### Context
`canonical-group-send.ts` and the session prompt path use `window.hermesDesktop.preparedSubmissions {read, compareAndSet}` when present, else `localStorage`. Android kills background WebViews often.

#### Tasks
- [ ] `read()` and atomic `compareAndSet` backed by Capacitor Preferences (or write-then-rename); serialise calls.
- [ ] Match the Electron contract in `apps/desktop/electron/preload.ts` exactly.
- [ ] Unit tests: CAS conflict, absent key, concurrent calls, corrupt store recovery.
- [ ] Headless: reload the page mid-send. Tablet checklist item: force-stop during a room send, reopen.

#### Acceptance criteria
- [ ] The message is re-sent with the same `event_id` and appears exactly once.
- [ ] No journal text in `localStorage`.
- [ ] Automated check passes on the box: built bundle in headless Chrome at phone (412×915) and tablet (1280×800) sizes against https://pavillion-claw.tailfc1337.ts.net.
- [ ] Basil ticks the milestone's device checklist on his Android tablet against pavillion-claw (about 5 minutes; screenshots where the checklist asks). No adb, no bot driving the device.

#### Files
- `apps/mobile/src/bridge/prepared-submissions.ts (new)`
- `apps/mobile/src/bridge/install-bridge.ts`

#### Dependencies
- HM-16 (resync first)

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-13] Inventory renderer-local storage on mobile; keep only UI prefs on the device

Labels: `track:app`, `type:chore`, `area:storage`, `priority:P1` · Assignee role: eng-a

**ID:** HM-13 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M1 · Gateway-only client

#### Context
Option D: no conversation state on the device. The renderer still writes several keys (local room map in `group-chat.ts`, bot sections, caches).

#### Tasks
- [ ] In the harness, dump every `localStorage`/IndexedDB key written in a 20-minute scripted session.
- [ ] Classify: UI preference (OK), rebuildable cache (OK, documented), conversation state (fix in HM-12/HM-14 or new issue).
- [ ] Table in `docs/ARCHITECTURE.md`; rule in the PR checklist; review `stubs.ts`.

#### Acceptance criteria
- [ ] Table merged; every 'not OK' key has a fix or issue.
- [ ] Lead agrees.

#### Files
- `docs/ARCHITECTURE.md`
- `apps/mobile/src/bridge/stubs.ts`

#### Dependencies
- HM-05
- HM-06

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-14] Gateway rooms only: remove the device-local room create path on mobile

Labels: `track:app`, `type:feature`, `area:rooms`, `priority:P0` · Assignee role: eng-a

**ID:** HM-14 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M1 · Gateway-only client

#### Context
Basil has 3 bots and no existing rooms, so there is nothing to migrate. The goal is that every room is a gateway room, fully synced between Desktop and the app. `groupExecutionMode` is `canonical` only when `groups.capabilities.driver === true`; otherwise the renderer would create device-only rooms.

#### Tasks
- [ ] Smallest override point (plugin decision or alias shim, HM-16) so mobile lists and creates only canonical rooms.
- [ ] When the gateway reports `legacy`/`unavailable`, show a message pointing to `docs/GATEWAY_SETUP.md` instead.
- [ ] If a renderer change is needed, hand it to Eng B as an upstream issue.

#### Acceptance criteria
- [ ] A room created in the app is visible on Desktop, and vice versa (harness + Desktop).
- [ ] No room data written on the device (HM-13 check).
- [ ] Automated check passes on the box: built bundle in headless Chrome at phone (412×915) and tablet (1280×800) sizes against https://pavillion-claw.tailfc1337.ts.net.

#### Files
- `apps/mobile/src/overrides/ (new)`
- `apps/desktop/src/plugins/hermes-bots/canonical-group-capabilities.ts (read only)`

#### Dependencies
- HM-13
- HM-16

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-15] Resume and reconnect: app lifecycle, network changes, replay epoch

Labels: `track:app`, `type:feature`, `area:sessions`, `area:rooms`, `needs-device-verify`, `priority:P0` · Assignee role: eng-a

**ID:** HM-15 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M1 · Gateway-only client

#### Context
The gateway gives `session.events.since` (`epoch`, `truncated`, `open_requests`) and `groups.log since_seq`. Tickets from `/api/auth/ws-ticket` are short-lived.

#### Tasks
- [ ] On `App` resume and `Network` change: fresh ws-ticket, reconnect, replay; epoch reset → refetch.
- [ ] Open rooms refetch from their last seq.
- [ ] Bridge tests for ticket refresh and backoff.
- [ ] Headless: drop the network 60 s (CDP offline) and hide the page 10 min. Tablet checklist: airplane mode 60 s, Tailscale off/on, 10 min backgrounded.

#### Acceptance criteria
- [ ] Recovers without re-login and shows everything that happened meanwhile.
- [ ] No duplicate messages.
- [ ] Automated check passes on the box: built bundle in headless Chrome at phone (412×915) and tablet (1280×800) sizes against https://pavillion-claw.tailfc1337.ts.net.
- [ ] Basil ticks the milestone's device checklist on his Android tablet against pavillion-claw (about 5 minutes; screenshots where the checklist asks). No adb, no bot driving the device.

#### Files
- `apps/mobile/src/bridge/connection.ts`
- `apps/mobile/src/bridge/auth.ts`
- `apps/mobile/src/mobile/`

#### Dependencies
- HM-04

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-16] Resync the renderer to upstream main and add an override/carry-patch mechanism

Labels: `track:app`, `type:chore`, `area:renderer`, `priority:P0` · Assignee role: eng-a

**ID:** HM-16 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M1 · Gateway-only client

#### Context
The renderer is pinned at `7bda2a33`; upstream main is 167+ commits ahead. We need one documented place for mobile-only shims and for carrying Eng B's patches until they merge.

#### Tasks
- [ ] Resync `apps/desktop` + `apps/shared` + lockfile to a chosen SHA; rerun tests, typecheck, harness, APK build.
- [ ] `apps/mobile/src/overrides/` + table in `docs/ARCHITECTURE.md` (what, why, removal condition).
- [ ] `patches/upstream/*.patch` applied by a script, each linked to its upstream PR; CI fails if one no longer applies.
- [ ] Resync cadence: start of each milestone and after Eng B PRs merge.

#### Acceptance criteria
- [ ] Builds and passes tests on the new SHA.
- [ ] Override and carry-patch tables exist.
- [ ] Automated check passes on the box: built bundle in headless Chrome at phone (412×915) and tablet (1280×800) sizes against https://pavillion-claw.tailfc1337.ts.net.

#### Files
- `apps/desktop/**, apps/shared/** (resync only)`
- `apps/mobile/vite.config.ts`
- `apps/mobile/src/overrides/ (new)`
- `patches/upstream/ (new)`
- `docs/ARCHITECTURE.md`

#### Dependencies
- None

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-17] Verify bot-to-bot through the backend inbox with no Desktop running

Labels: `track:gateway`, `type:test`, `area:bots`, `priority:P0` · Assignee role: eng-b

**ID:** HM-17 · **Track:** Eng B (gateway/upstream) · **Milestone:** M1 · Gateway-only client

#### Context
All bot-to-bot traffic goes through the backend inbox on the one gateway: durable delivery under `<profile>/runtime/bot_live_delivery/` (`tools/bot_live_delivery.py`, admission in `gateway/session_bot.py`). There is no second machine and no relay. Constraint: real LLM turns use DeepSeek Flash only, within the $5/month test spend cap; keep prompts short and record the turns used.

#### Tasks
- [ ] With Desktop quit, ask bot A (in its Bot Chat, via the harness) to message bot B.
- [ ] Check the receipt reaches `settled`, the reply returns to A, and both Bot Chats show it in the app.
- [ ] Repeat with B busy and with B's provider failing (typed `reason`).
- [ ] Short runbook of observed states.

#### Acceptance criteria
- [ ] Three scenarios documented with receipt states.
- [ ] No Desktop process during the test (process list attached).
- [ ] Constraint: real LLM turns use DeepSeek Flash only, within the $5/month test spend cap; keep prompts short and record the turns used.

#### Files
- `docs/GATEWAY_SETUP.md (runbook section)`

#### Dependencies
- HM-09

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-18] Patched hermes-agent branch on pavillion-claw: deploy, rollback, upstream PR flow

Labels: `track:gateway`, `type:chore`, `area:setup`, `priority:P0` · Assignee role: eng-b

**ID:** HM-18 · **Track:** Eng B (gateway/upstream) · **Milestone:** M1 · Gateway-only client

#### Context
Basil approved running a patched hermes-agent branch on his gateway until upstream merges. Upstream PRs go to NousResearch/hermes-agent from the `basilrari` account, and Basil approves each PR's title and body first (G3).

#### Tasks
- [ ] Branch on Basil's fork, rebased on a pinned upstream SHA; each patch maps to one upstream PR.
- [ ] Runbook: install the branch on pavillion-claw, restart both processes, run the doctor, roll back to stock in one command.
- [ ] PR draft template (title, body, tests) saved in `planning/upstream-prs/` for Basil's approval; nothing opened without it.

#### Acceptance criteria
- [ ] Rollback tested once (stock → patched → stock) with doctor green each time.
- [ ] Template in place.

#### Files
- `docs/GATEWAY_SETUP.md`
- `planning/upstream-prs/ (new)`

#### Dependencies
- HM-08
- HM-09

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

## M2 · Live sync & read state

### [HM-19] Upstream PR: `groups.event` push for hosted rooms

Labels: `track:gateway`, `upstream-pr`, `type:feature`, `area:rooms`, `area:protocol`, `priority:P0` · Assignee role: eng-b

**ID:** HM-19 · **Track:** Eng B (gateway/upstream) · **Milestone:** M2 · Live sync & read state

#### Context
Clients poll rooms every 2 s. Rooms already have a durable per-room `seq`. Add a push hint so clients fetch deltas only. Refs #95163.

#### Tasks
- [ ] Per HM-10: frame `groups.event {room_id, latest_seq, kind, epoch}` via `_broadcast_global_event`.
- [ ] Cross-process safe (rooms may be appended by `hermes gateway` while `hermes dashboard` serves the WS): `change_watcher`-style signature on the hosted-room DB; coalesce bursts.
- [ ] Advertise `event_push`.
- [ ] Tests next to `test_groups_methods.py` / `test_change_watcher.py`: emit, coalesce, no-op, restart.
- [ ] Draft PR title/body for Basil (G3); carry the patch on the HM-18 branch meanwhile.

#### Acceptance criteria
- [ ] New tests pass.
- [ ] A second WS client gets `groups.event` within 1 s of an append.
- [ ] PR opened only after G3.

#### Files
- `tui_gateway/methods_groups.py`
- `tui_gateway/change_watcher.py`
- `tui_gateway/server.py (use only)`
- `tests/tui_gateway/`

#### Dependencies
- HM-10 (G0)
- HM-18 (branch)

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-20] Upstream PR: renderer uses `groups.event` and incremental `groups.log`

Labels: `track:gateway`, `upstream-pr`, `type:feature`, `area:rooms`, `area:renderer`, `priority:P0` · Assignee role: eng-b

**ID:** HM-20 · **Track:** Eng B (gateway/upstream) · **Milestone:** M2 · Live sync & read state

#### Context
`canonical-group-workspace.tsx` `refresh()` re-reads the whole log from `since_seq: 0` every 2 s. Desktop and the app share this client.

#### Tasks
- [ ] Keep the loaded log; fetch only `since_seq = last seq`; reset on epoch change.
- [ ] Subscribe to `groups.event` when advertised; slower polling otherwise [decide in review].
- [ ] Vitest next to the canonical-group tests.

#### Acceptance criteria
- [ ] With `event_push`, no periodic full-log reads (trace).
- [ ] Without it, behaviour equals today's.

#### Files
- `apps/desktop/src/plugins/hermes-bots/canonical-group-workspace.tsx`
- `apps/desktop/src/plugins/hermes-bots/canonical-groups.ts`

#### Dependencies
- HM-19

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-21] Upstream PR: room read cursors (`groups.read`, `read_seq`, `unread_count`)

Labels: `track:gateway`, `upstream-pr`, `type:feature`, `area:rooms`, `area:read-state`, `priority:P0` · Assignee role: eng-b

**ID:** HM-21 · **Track:** Eng B (gateway/upstream) · **Milestone:** M2 · Live sync & read state

#### Context
Rooms have no read state. Decision: read on one device means read everywhere, so one user-level watermark per room (like sessions' `last_read_at`). Refs #95163, #126725.

#### Tasks
- [ ] Per HM-10: watermark table in `shared-state.db`; `groups.read {room_id, seq, device_id?}`; `read_seq` + `unread_count` in `groups.list`/`groups.state`.
- [ ] Monotonic, idempotent, migration in the hosted-rooms style.
- [ ] Emit `groups.event {kind: "read"}`; feature `read_cursors`.
- [ ] Tests incl. restart.

#### Acceptance criteria
- [ ] Unread counts correct across restart.
- [ ] Older clients unaffected.
- [ ] PR opened only after G3.

#### Files
- `gateway/hosted_rooms.py`
- `tui_gateway/methods_groups.py`
- `tests/`

#### Dependencies
- HM-10
- HM-19

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-22] Upstream PR: per-device resume cursors

Labels: `track:gateway`, `upstream-pr`, `type:feature`, `area:read-state`, `priority:P2` · Assignee role: eng-b

**ID:** HM-22 · **Track:** Eng B (gateway/upstream) · **Milestone:** M2 · Live sync & read state

#### Context
Read state is global (HM-21). Per-device state is only for "reopen where this device was". Low priority; drop if upstream review pushes back.

#### Tasks
- [ ] Per HM-10: `{device_id, label, last_seen_at}` and per-conversation `last_seen_seq`/`last_seen_at`; TTL for stale devices; feature `device_cursors`.
- [ ] No hardware IDs or IPs.
- [ ] Tests.

#### Acceptance criteria
- [ ] Resume position survives restart in tests.

#### Files
- (new module beside gateway/hosted_rooms.py, per upstream review)
- `tests/`

#### Dependencies
- HM-21

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-23] Upstream PR: renderer unread badges and mark-read for gateway rooms

Labels: `track:gateway`, `upstream-pr`, `type:feature`, `area:renderer`, `area:read-state`, `priority:P1` · Assignee role: eng-b

**ID:** HM-23 · **Track:** Eng B (gateway/upstream) · **Milestone:** M2 · Live sync & read state

#### Context
Renderer side of HM-21/22: unread counts on rooms, `groups.read` when visible at the bottom, resume at the device cursor if available.

#### Tasks
- [ ] Badges; mark-read on visibility + bottom; update on `groups.event {kind: read}`.
- [ ] Device id from optional `window.hermesDesktop.deviceIdentity()`, else renderer-generated.
- [ ] Feature-detect; vitest.

#### Acceptance criteria
- [ ] Badges clear across two clients in tests.
- [ ] No change on gateways without the features.

#### Files
- `apps/desktop/src/plugins/hermes-bots/roster-pane.tsx`
- `apps/desktop/src/plugins/hermes-bots/canonical-group-workspace.tsx`

#### Dependencies
- HM-20
- HM-21

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-24] Upstream PR (stretch): durable session replay buffer

Labels: `track:gateway`, `upstream-pr`, `type:feature`, `area:sessions`, `stretch`, `priority:P2` · Assignee role: eng-b

**ID:** HM-24 · **Track:** Eng B (gateway/upstream) · **Milestone:** M2 · Live sync & read state

#### Context
Stays a stretch goal. `tui_gateway/event_replay.py` is in memory and changes `epoch` on restart; history still comes from `state.db`. Only helps in-flight streams across a restart. Start only if M2 is otherwise done.

#### Tasks
- [ ] Design note: bounded on-disk ring, stable epoch.
- [ ] Implement + restart tests.
- [ ] Measure write overhead.

#### Acceptance criteria
- [ ] Reconnect after restart replays missed frames in tests.
- [ ] Overhead acceptable to lead.

#### Files
- `tui_gateway/event_replay.py`
- `tests/tui_gateway/`

#### Dependencies
- HM-10

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-25] Device identity in the bridge (`deviceIdentity()`)

Labels: `track:app`, `type:feature`, `area:read-state`, `priority:P2` · Assignee role: eng-a

**ID:** HM-25 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M2 · Live sync & read state

#### Context
Resume cursors (HM-22) need a stable, non-secret device id and label.

#### Tasks
- [ ] Random UUID on first launch in Preferences; label defaults to device model, editable.
- [ ] Expose `window.hermesDesktop.deviceIdentity()` per HM-10.
- [ ] Unit tests.

#### Acceptance criteria
- [ ] Same id across relaunches; new id after data clear.
- [ ] No hardware identifiers.

#### Files
- `apps/mobile/src/bridge/device-identity.ts (new)`
- `apps/mobile/src/bridge/install-bridge.ts`

#### Dependencies
- HM-10

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-26] Integrate live sync and read state in the app

Labels: `track:app`, `type:feature`, `area:rooms`, `area:read-state`, `needs-device-verify`, `priority:P0` · Assignee role: eng-a

**ID:** HM-26 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M2 · Live sync & read state

#### Context
Brings HM-19..23 into the app via carried patches (HM-16), against pavillion-claw running the HM-18 branch. Constraint: real LLM turns use DeepSeek Flash only, within the $5/month test spend cap; keep prompts short and record the turns used.

#### Tasks
- [ ] Apply carried patches; confirm feature detection on patched and stock gateways.
- [ ] Harness, two clients (phone + tablet size) and Desktop on one room: 20 messages each way, latency from trace timestamps.
- [ ] Read on one client → badge clears on the others; restart gateway → counts intact.
- [ ] Tablet checklist: send from Desktop, see it on the tablet; read on the tablet, Desktop clears.

#### Acceptance criteria
- [ ] p95 ≤ 2 s over 20 messages; no 2 s full-log polling.
- [ ] Stock gateway still works by polling.
- [ ] Read state syncs within 3 s.
- [ ] Constraint: real LLM turns use DeepSeek Flash only, within the $5/month test spend cap; keep prompts short and record the turns used.
- [ ] Automated check passes on the box: built bundle in headless Chrome at phone (412×915) and tablet (1280×800) sizes against https://pavillion-claw.tailfc1337.ts.net.
- [ ] Basil ticks the milestone's device checklist on his Android tablet against pavillion-claw (about 5 minutes; screenshots where the checklist asks). No adb, no bot driving the device.

#### Files
- `patches/upstream/`
- `apps/mobile/src/overrides/`
- `docs/VERIFICATION.md`

#### Dependencies
- HM-16
- HM-20
- HM-23

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

## M3 · Continuity verified (no Desktop)

### [HM-27] Continuity matrix with Desktop closed

Labels: `track:app`, `type:test`, `needs-device-verify`, `priority:P0` · Assignee role: eng-a

**ID:** HM-27 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M3 · Continuity verified (no Desktop)

#### Context
The goal in one test: same chats, rooms and bot-to-bot threads on Desktop and the app, shared read state, pick up mid-conversation, no Desktop required. Constraint: real LLM turns use DeepSeek Flash only, within the $5/month test spend cap; keep prompts short and record the turns used.

#### Tasks
- [ ] Harness: {Desktop, app at tablet size, app at phone size} × {single-bot chat, room, bot-to-bot thread} × {send, read, resume mid-stream, resume after reload, resume after gateway restart}.
- [ ] Include: room started on Desktop, Desktop quit, app joins mid-round and sends.
- [ ] Tablet checklist (5 min): the Desktop-quit room scenario and one force-stop resume.
- [ ] Pass/fail per cell; file bugs; rerun until green or waived by Basil.

#### Acceptance criteria
- [ ] Every cell passes or has a Basil-approved waiver.
- [ ] Constraint: real LLM turns use DeepSeek Flash only, within the $5/month test spend cap; keep prompts short and record the turns used.
- [ ] Automated check passes on the box: built bundle in headless Chrome at phone (412×915) and tablet (1280×800) sizes against https://pavillion-claw.tailfc1337.ts.net.
- [ ] Basil ticks the milestone's device checklist on his Android tablet against pavillion-claw (about 5 minutes; screenshots where the checklist asks). No adb, no bot driving the device.

#### Files
- `docs/VERIFICATION.md`
- `scripts/e2e/scenarios/`

#### Dependencies
- HM-26
- HM-17
- HM-15

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-28] Gateway restart and 1-hour soak on pavillion-claw (two processes, one home)

Labels: `track:gateway`, `type:test`, `area:rooms`, `priority:P1` · Assignee role: eng-b

**ID:** HM-28 · **Track:** Eng B (gateway/upstream) · **Milestone:** M3 · Continuity verified (no Desktop)

#### Context
`hermes gateway` and `hermes dashboard` both run on pavillion-claw and may both start a room driver on `shared-state.db` (R4). Constraint: real LLM turns use DeepSeek Flash only, within the $5/month test spend cap; keep prompts short and record the turns used.

#### Tasks
- [ ] 1-hour 3-bot room, no clients attached; restart each process once mid-round.
- [ ] Check `groups.log` seq gap-free with no duplicate user events; check which process holds the authority epoch.
- [ ] Report CPU/RAM, DB growth and turns/spend used.

#### Acceptance criteria
- [ ] Seq continuity output attached; no duplicates.
- [ ] Spend within the cap.
- [ ] Upstream bug drafted if found (G3 before filing).

#### Files
- `scripts/soak/ (new)`
- `docs/VERIFICATION.md`

#### Dependencies
- HM-19
- HM-21

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-29] Update ARCHITECTURE.md and VERIFICATION.md for Option D

Labels: `track:app`, `type:docs`, `priority:P2` · Assignee role: eng-a

**ID:** HM-29 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M3 · Continuity verified (no Desktop)

#### Context
Docs still describe a thin client of the Desktop renderer.

#### Tasks
- [ ] Architecture diagram and data flows (sessions, rooms, bot inbox, one gateway).
- [ ] VERIFICATION.md: harness results and Basil's tablet checklists per milestone.
- [ ] README: Android only, new app ID, HTTPS only.

#### Acceptance criteria
- [ ] Lead review passes; docs match the plan.

#### Files
- `docs/ARCHITECTURE.md`
- `docs/VERIFICATION.md`
- `README.md`

#### Dependencies
- HM-27

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

## M4 · Tablet polish

### [HM-30] Tablet layout polish

Labels: `track:app`, `type:feature`, `area:tablet`, `needs-device-verify`, `priority:P1` · Assignee role: eng-a

**ID:** HM-30 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M4 · Tablet polish

#### Context
Polish for daily use on Basil's tablet; the list comes from M0–M3 checklist notes.

#### Tasks
- [ ] Agree a short list with lead (e.g. room member pane, composer above keyboard in landscape, rotation mid-compose, multi-window, touch targets).
- [ ] Fix in `apps/mobile/src/mobile` CSS/behaviour, or upstream issues for generic renderer problems.
- [ ] Harness screenshots at tablet size in both orientations for each item.

#### Acceptance criteria
- [ ] Every item passes in the harness.
- [ ] Basil ticks the milestone's device checklist on his Android tablet against pavillion-claw (about 5 minutes; screenshots where the checklist asks). No adb, no bot driving the device.

#### Files
- `apps/mobile/src/mobile/`
- `apps/mobile/src/styles.css`

#### Dependencies
- HM-27

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-31] Phone-size layout pass in the harness

Labels: `track:app`, `type:feature`, `area:tablet`, `priority:P2` · Assignee role: eng-a

**ID:** HM-31 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M4 · Tablet polish

#### Context
The phone is not a test target, but the app should not break at phone width (<640 px edge overlay sidebar). Checked in headless Chrome only.

#### Tasks
- [ ] Check room view, member list, attachments and composer at 412×915; fix the top problems.

#### Acceptance criteria
- [ ] Agreed list passes in the harness at phone size.

#### Files
- `apps/mobile/src/mobile/`

#### Dependencies
- HM-30

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-32] Background behaviour: close the socket and stop polling when backgrounded

Labels: `track:app`, `type:test`, `area:sessions`, `needs-device-verify`, `priority:P1` · Assignee role: eng-a

**ID:** HM-32 · **Track:** Eng A (app/bridge/Android) · **Milestone:** M4 · Tablet polish

#### Context
No push notifications, so the app has no reason to work in the background. It should close the WS and stop polling, then catch up on resume (HM-15).

#### Tasks
- [ ] Close WS and stop timers on `App` pause; reconnect on resume.
- [ ] Harness: hidden page makes no requests for 10 min (trace).
- [ ] Tablet checklist: leave the app backgrounded overnight; Android battery screen shows it near zero.

#### Acceptance criteria
- [ ] No requests while hidden (trace).
- [ ] Catch-up on resume is complete.
- [ ] Automated check passes on the box: built bundle in headless Chrome at phone (412×915) and tablet (1280×800) sizes against https://pavillion-claw.tailfc1337.ts.net.
- [ ] Basil ticks the milestone's device checklist on his Android tablet against pavillion-claw (about 5 minutes; screenshots where the checklist asks). No adb, no bot driving the device.

#### Files
- `apps/mobile/src/bridge/connection.ts`

#### Dependencies
- HM-15

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.

### [HM-33] Upstream follow-through: review responses and patch rebase

Labels: `track:gateway`, `upstream-pr`, `type:chore`, `priority:P1` · Assignee role: eng-b

**ID:** HM-33 · **Track:** Eng B (gateway/upstream) · **Milestone:** M4 · Tablet polish

#### Context
Upstream merges are not ours to control. Keep the open PRs current and shrink the carried patches as they merge.

#### Tasks
- [ ] Answer review comments (replies drafted for Basil's OK where they change scope).
- [ ] Rebase the HM-18 branch on current upstream; drop merged patches; rerun gateway tests and the harness.
- [ ] Update the carry-patch table (HM-16).

#### Acceptance criteria
- [ ] Branch rebased and doctor green.
- [ ] Carry-patch table matches reality.

#### Files
- `planning/upstream-prs/`
- `patches/upstream/`

#### Dependencies
- HM-18
- HM-19
- HM-21

#### Review
- Lead adversarial review (G1): one issue per PR, tests, no secrets, failure modes stated.
