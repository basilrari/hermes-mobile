# Handoff: hermes-mobile

This page is for an agent taking over the project. It covers the goal, the decisions already made, the rules, how to build and test, what is merged, what is open, and what to do next. State was last updated from GitHub on 2026-10-17 (Taipei), after #51 merged. **Everything in this file was re-checked against `main` on that date** — if a section disagrees with the repo, the repo wins and this file is the bug (`HM-29`).

## 1. Goal and scope

hermes-mobile is an Android-only [Capacitor](https://capacitorjs.com) tablet client for [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent). It runs the upstream `apps/desktop` renderer in a WebView and talks to a remote Hermes gateway over HTTPS and WSS. The device runs no agent, model, or tools.

The project follows **Option D: the gateway is the single source of truth.** Sessions, gateway-hosted rooms, read state, and bot-to-bot threads live on the gateway. The app keeps no conversation state on the device. Desktop and the app must show the same chats, rooms, and bot threads, with shared read state, and Desktop does not need to be running.

Out of scope:

- Push notifications.
- iOS.
- Telegram sync with Desktop or the app (Telegram runs on the same gateway but stays separate).
- `hermes peer`, cross-gateway messaging, or any second machine.
- Google Play or any app store, release signing keys, store listings.
- Fixing the Desktop bot relay (`relay.ts`); the app avoids it.

The full plan is [`planning/PLAN.md`](../planning/PLAN.md).

## 2. Basil's decisions (2026-10-16)

| Topic | Decision |
|---|---|
| Device checks | Basil runs a checklist of about 5 minutes per milestone by hand on his Android tablet. No adb, no bot driving the device. The phone is not a test target. |
| Automated checks | Headless Chrome on the box at 412×915 (phone) and 1280×800 (tablet), both orientations, against his gateway, plus unit and gateway tests. |
| Patched gateway | A patched hermes-agent branch on his machine is OK until upstream merges. |
| Upstream PRs | Opened from the `basilrari` account to NousResearch/hermes-agent. Basil approves each PR's title and body before it opens. |
| Push | None. |
| Read state | Read on one device means read everywhere. |
| Gateway layout | One machine, `pavillion-claw`, runs `hermes gateway` and `hermes dashboard`. The dashboard listens on loopback port 9119 behind `tailscale serve` at `https://pavillion-claw.tailfc1337.ts.net`, with basic auth and `HERMES_DASHBOARD_PUBLIC_URL` set to that URL. |
| Existing data | No rooms yet. Three bots. Nothing to migrate. |
| Test inference | DeepSeek Flash, capped at $5 per month. |
| App ID | `io.github.basilrari.hermesmobile` (merged in #34). Users reinstall once. |
| Transport | HTTPS only. Cleartext off. |
| Timeline | None. Work as fast as possible; milestones have no due dates. |

## 3. Hard rules

1. **No secrets anywhere.** No tokens, passwords, keys, or keystores in commits, PR bodies, issues, logs, or screenshots. Gateway credentials are entered at runtime only. Never print `GH_TOKEN`.
2. **Basil's credentials never go to cloud VMs.** Cloud agents cannot reach pavillion-claw and must not be given its password. Live checks against pavillion-claw are Basil's checklist, or a run on his own machine.
3. **The lead (Hermes Mobile) reviews and approves every merge.** Engineers do not merge their own PRs.
4. **One issue per PR, with proof.** Every PR names its issue and attaches the evidence that applies: APK build output, `npm test` and `npm run typecheck` output, unit test output, and headless screenshots at the required sizes for UI changes.
5. **Keep upstream attribution.** The app comes from [NousResearch/hermes-agent PR #49834](https://github.com/NousResearch/hermes-agent/pull/49834) by [@Bentlybro](https://github.com/Bentlybro). Keep the README credit and the `LICENSE` terms.
6. **No upstream PR without Basil's approval** of its title and body (gate G3).

## 4. Architecture in brief

```
Android tablet                                   pavillion-claw
┌──────────────────────────────────────┐         ┌──────────────────────────────────┐
│ WebView, origin https://localhost    │  HTTPS  │ tailscale serve (ts.net, :443)   │
│  Desktop renderer (apps/desktop/src) │ ──────► │   → hermes dashboard 127.0.0.1:9119│
│  window.hermesDesktop = bridge       │  WSS    │     /api/status, /api/auth/*,    │
│  (apps/mobile/src/bridge)            │ ──────► │     /api/ws (JSON-RPC)           │
└──────────────────────────────────────┘         │ hermes gateway (Telegram)        │
                                                 └──────────────────────────────────┘
```

- In Electron, the renderer talks to the main process through `window.hermesDesktop`. On mobile, `apps/mobile/src/bridge` installs a browser-side implementation before the renderer boots.
- REST calls go through CapacitorHttp (native HTTP), which avoids the browser CORS limit. Login gets short-lived WebSocket tickets from `/api/auth/ws-ticket`.
- `vite.config.ts` aliases `@` to `../desktop/src` and `@hermes/shared` to `../shared/src`, so the renderer compiles into the mobile bundle without a fork.
- Rooms are gateway-hosted (`groups.*` over `/api/ws`, stored in `shared-state.db`). Sessions live in each profile's `state.db`. Bot-to-bot goes through the backend inbox (`message_agent`, `<profile>/runtime/bot_live_delivery/`).

More detail: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md). Gateway setup: [`docs/GATEWAY_SETUP.md`](GATEWAY_SETUP.md).

## 5. Repository layout

| Path | Contents |
|---|---|
| `apps/mobile` | The Capacitor app: bridge, connect and login screens, Android project (`apps/mobile/android`). |
| `apps/mobile/src/bridge` | `window.hermesDesktop` implementation and its vitest tests. |
| `apps/mobile/src/mobile` | Mobile-only UI: connect screens, safe-area and keyboard behaviour, theme fallback. |
| `apps/desktop` | Upstream renderer source, pinned to hermes-agent `450ad5055e`. Do not edit except through a resync. |
| `apps/shared` | Upstream shared gateway client (`@hermes/shared`). |
| `patches/` | `patch-package` fix for `@capacitor-community/safe-area`. |
| `scripts/check-legacy-app-id.mjs` | Fails if the previous application ID appears anywhere except the one README reinstall line. Runs as part of `npm test`. Do not write the old ID in new files. |
| `scripts/gateway-doctor/` | Read-only doctor for pavillion-claw (`doctor.py`, `test_doctor.py`). |
| `docs/` | `ARCHITECTURE.md`, `GATEWAY_SETUP.md`, `VERIFICATION.md`, this file. |
| `planning/` | `PLAN.md`, `issues.md`, `issues.json`, `overview.html`. |
| `planning/contracts/` | G0 protocol contracts: `groups-event.md`, `read-cursors.md`, `device-identity.md`, `bridge-additions.md`. |
| `verify/` | Emulator screenshots from v0.1.0. |

## 6. Build, test, and verify

Requirements: Node 22 or later, JDK 21, Android SDK platform 36 with build-tools, `ANDROID_HOME` set.

### Install

```bash
npm ci --ignore-scripts   # use upstream's lockfile; skip Electron native builds
npx patch-package         # apply patches/
node scripts/apply-upstream-patches.mjs   # the other half of postinstall; patches/upstream
```

### Unit tests and typecheck

```bash
cd apps/mobile
npm test            # vitest (bridge) + scripts/check-legacy-app-id.mjs
npm run typecheck   # tsc -p tsconfig.app.json --noEmit
```

`apps/mobile`'s `npm test` reports **187 passing tests in 20 files** as of #56. The number moves with every merge; if it disagrees with your run, the repo is right and this line needs the new figure.

Pitfall: `apps/mobile/android/app/src/main/assets/capacitor.config.json` is generated and git-ignored. In a checkout that was synced before #34, it still holds the old app ID, and the app-ID check in `npm test` fails with `expected exactly one hit, in README.md; found 2`. Run `npm run sync:android` from the repo root (Node 22+) to regenerate it; that script, and `npm run cap:sync` inside `apps/mobile`, also run `scripts/check-capacitor-config.mjs`, which fails unless the synced config's effective `loggingBehavior` (the nested `android.loggingBehavior` wins, as `CapConfig` reads it) resolves to `none` — a missing key falls back to `debug`, which turns bridge logging on in a debuggable build.

### Debug APK

```bash
cd apps/mobile
npm run build                 # vite → apps/mobile/dist
npm run cap:sync              # cap sync + the synced-config guard
cd android && ./gradlew assembleDebug
# → apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

The root script `npm run apk:debug` runs the same three steps. The current version is `versionName "0.1.1"`, `versionCode 2`.

### Headless verification

The harness (#6) exists. Run it:

```bash
npm run e2e        # builds, then drives the built bundle in headless Chrome
```

It logs in against an in-process **mock** gateway at four viewports (412x915,
915x412, 800x1280, 1280x800) and asserts, per viewport: the connect screen
renders; an `http://` gateway is refused **with a visible reason**; token login
reaches the chat shell; the Bots roster surface is reachable; no horizontal
overflow; the composer is inside the viewport; no new control is under the 24px
touch floor; the RPC trace is live and shows **zero `bot_relay.*`**;
`preparedSubmissions` is exposed while the renderer's `localStorage` fallback
stays empty; `deviceIdentity()` returns a v4 uuid and a non-empty label; and
**no conversation state is in `localStorage`, `sessionStorage`, or an IndexedDB
database name**. Plus a two-client pass and an id-across-a-relaunch pass. It is
**59 checks** (14 per viewport × 4, plus 2 two-client, plus 1 relaunch). The
e2e job on `fac731f` printed `59/59` (run 38986142771).

It cannot prove device, cookie or room behaviour (a browser uses `fetch`, not
CapacitorHttp, and cannot read `Set-Cookie`; no hosted room is opened anywhere).
Those stay on Basil's tablet checklist. To run it against the real box:
`HERMES_E2E_GATEWAY_URL=… HERMES_E2E_TOKEN=… npm run e2e` on Basil's machine.

The older manual recipe, if the harness is unavailable:

1. `npm run build` in `apps/mobile`.
2. Serve the bundle: `npx vite preview --host 127.0.0.1 --port 5180 --strictPort`.
3. Drive Chrome headless (Playwright is in the root `node_modules`; system Chrome also works with puppeteer-core) at 412×915, 915×412, 800×1280, and 1280×800.
4. Attach the four screenshots to the PR.

A browser run uses `fetch` instead of CapacitorHttp, so it cannot prove native HTTP, cookies, or Android lifecycle behaviour. Those belong on Basil's tablet checklist. Gateway runs against pavillion-claw need its password and must happen on Basil's machine (rule 2), so cloud runs use a local `hermes dashboard` or none.

### Gateway doctor

```bash
cd scripts/gateway-doctor && python3 -m unittest test_doctor.py -v   # 31 tests
```

On pavillion-claw, Basil runs the doctor as shown in [`docs/GATEWAY_SETUP.md`](GATEWAY_SETUP.md#driver-check): the password is read with `read -rs` into `HERMES_DASHBOARD_PASSWORD`, never typed on a command line. Exit 1 means at least one check failed; warnings alone exit 0.

## 7. Current state

### Merged

| PR | Squash commit | Issue | Content |
|---|---|---|---|
| #34 | `dc8f0c2` | #1 (HM-01) | App ID `io.github.basilrari.hermesmobile`; app-ID check script. |
| #36 | `21731e8` | #2 (HM-02) | HTTPS only: `androidScheme: 'https'`, cleartext off, `http://`/`ws://` URLs refused, `wss://` derivation test. |
| #40 | `4dd7942` | (cleanup) | Removed `cap:ios` and `@capacitor/ios`; README and ARCHITECTURE describe Android HTTPS-only. |
| #37 | `e4a4c5e` | #8 (HM-08) | Read-only gateway doctor, 31 tests. Lease check fails only on an epoch mismatch or a lease for an unknown room; two generations on different rooms warn; logs out after the capabilities call. |
| #38 | `e5b2e4b` | #9 (HM-09) | `docs/GATEWAY_SETUP.md`: loopback 9119, `HERMES_DASHBOARD_PUBLIC_URL`, `tailscale serve --bg 9119`, interactive or stdin password hashing, systemd keep-alive on 127.0.0.1, bot markers, doctor. |
| #35 | `639229f` | #10 (HM-10) | G0 contracts in `planning/contracts/`, approved by the lead. Codes: `groups.read` uses `4126`/`5124`, `devices.*` use `4125`/`5123`. `groups.read` joins the groups `_METHODS` tuple; `devices.*` register only in `server._methods` and the contract registry. `device_cursors` TTL is deliberately unfrozen (P2). |
| #39 | `78b8d70` | — | This handoff doc. |
| #41 | `8a82efa` | — | Repo standard: issue/PR templates + CI (`review-gate`, the only required check). Branch protection on `main`. |
| #42 | `606f2c5` | #7 (HM-07) | gitleaks guard: config, `.githooks/pre-commit`, `scripts/install-hooks.sh`, and the `checks` workflow (secrets + app tests + carried patches). |
| #43 | `d45315f` | #5 (HM-05) | Debug RPC trace: 2000-entry ring of method names/events/timings, `window.__hermesRpcTrace`, the version badge that shares it. |
| #44 | `e19ca8f` | #6 (HM-06) | Headless harness (`npm run e2e`): four viewports, mock gateway, checklist template, turn counter. |
| #45 | `a73318f` | #11 (HM-11) | The Desktop bot relay is off on mobile (Vite override); the harness asserts zero `bot_relay.*`. |
| #46 | `4586313` | #16 (HM-16) | Renderer pin recorded (`450ad5055e`, already byte-identical), override table, carried-patch mechanism + CI check. |
| #47 | `4c21384` | #12 (HM-12) | `preparedSubmissions` durable send journal in the bridge. |
| #48 | `69f6afd` | #25 (HM-25) | `deviceIdentity()` in the bridge. |
| #49 | `a67a475` | #13 (HM-13) | Measured on-device storage inventory + the no-conversation-state gate. |
| #51 | `8704948` | #14 (HM-14) | Gateway rooms only: never fall back to device-local rooms. |
| #54 | `a8012fc` | #30, #31 (HM-30/31) | Layout pass: phone and tablet layouts measured; the overflow that measurement found is fixed. |

Gate G0 was passed at #35, so M2 contract-dependent work (#19, #21, #22, #25) may start; #25 has landed.

### Not done yet

- **#18 patched hermes-agent branch:** still not started. No HM-18 branch in this repo and no `basilrari` hermes-agent fork on GitHub. Start fresh. It blocks #19 and the rest of the M2 critical path, and it must be *deployed* on pavillion-claw, which is Basil's machine (rule 2). `docs/GATEWAY_SETUP.md` ends with a `TODO(HM-18)` placeholder for its runbook.
- **Basil's M0 tablet checklist:** not run. Nothing in this repo can run it: it needs the tablet and the gateway password. Covers the renamed APK install, HTTPS login against `https://pavillion-claw.tailfc1337.ts.net`, the WSS and ws-ticket flow, a real DeepSeek Flash reply, and a doctor report from pavillion-claw (the #8 acceptance line).
- **New debug APK release:** still needed. Both published releases (`v0.1.0-debug`, `v0.1.1-debug`) carry the old app ID and the cleartext build. Build from current `main` and publish a new pre-release before Basil's checklist.
- **Upstream PRs (#19–#24, #33):** untouched. Gate G3 needs Basil's approval of each title and body before one opens, and they need a patched branch on his machine to test against.

### Issues

Closed: #1, #5, #6, #7, #8, #9, #10, #11, #12, #13, #14, #16, #25, #30, #31. #2 is still open even though #36 merged; close it after Basil's checklist confirms HTTPS login on the tablet.

Still open (21, `gh issue list --state open`, measured 2026-10-17): #2, #3, #4, #15, #17, #18, #19, #20, #21, #22, #23, #24, #26, #27, #28, #29, #32, #33, #52, #55, #57. Of those, the tablet still owns **#2**, #3, #4; pavillion-claw owns #17, #18, #28; a room-capable gateway or a device still owns #15, #26, #27, #29, #32; upstream is #19–#24 and #33; #55 (HM-35) and #57 (HM-34) are layout follow-ups; #52 is this pull request. Issue number N is HM-N except those two.

## 8. Order of work and critical path

Milestones close in order, each when its gate passes. Engineer A owns the app; Engineer B owns gateway and upstream work.

| Milestone | Issues (Eng A) | Issues (Eng B) | Gate |
|---|---|---|---|
| [M0 Baseline on device](https://github.com/basilrari/hermes-mobile/milestone/1) | #1 ✓, #2 (merged, awaiting tablet check), #3, #4, **#5 ✓, #6 ✓, #7 ✓** | #8 ✓, #9 ✓, #10 ✓ | Headless ✓; tablet checklist outstanding; G0 ✓ |
| [M1 Gateway-only client](https://github.com/basilrari/hermes-mobile/milestone/2) | **#11 ✓, #12 ✓, #13 ✓, #14 ✓, #16 ✓**, #15 (needs a device) | #17, #18 | Headless ✓; tablet checklist outstanding |
| [M2 Live sync and read state](https://github.com/basilrari/hermes-mobile/milestone/3) | #25 ✓, #26 | #19–#24 (#24 stretch) | Headless + tablet checklist |
| [M3 Continuity verified](https://github.com/basilrari/hermes-mobile/milestone/4) | #27, #29 | #28 | Headless + tablet checklist |
| [M4 Tablet polish](https://github.com/basilrari/hermes-mobile/milestone/5) | #30 ✓, #31 ✓, #32 | #33 | Headless + tablet checklist |

Key dependencies:

- App: #3 needs #1 and #2 (done) plus a new APK; #6 needs #2; #4 needs #3 and #6; #15 needs #4. #16 (renderer resync and override mechanism) unblocks #11, #12, #14.
- Gateway: #17 and #18 need #8 and #9 (done).
- **Critical path:** #18 (patched branch) → #19 (`groups.event`) → #20 and #21 → #23 → #26 (integration) → #27 (continuity matrix) → #30 ✓ (#54).

Next steps, in order — **the first two are Basil's; nothing in this repo can do them**:

1. **Basil:** build a debug APK from current `main` and publish a new pre-release (both published releases still carry the old app ID and the cleartext build), then run the M0 tablet checklist (#2, #3, #4) and the doctor on pavillion-claw.
2. **Basil:** approve the upstream PR titles and bodies (gate G3) and start #18 (the patched branch on pavillion-claw) — it blocks #19 and the rest of the M2 critical path. Nothing has been started.
3. Eng A: #55 and #57 are the layout follow-ups a box can do. #15, #26, #27, #29, and #32 still need a room-capable gateway or a device.
4. Then M1–M3 close in order once the tablet checks and #18–#21 are unblocked.

### Known risks

| Risk | Detail | Fix |
|---|---|---|
| Roster wipe | `plugin.tsx` calls `startBotRelay()`; with one connection, `relay.ts` sends `bot_relay.roster.sync { agents: [] }`, and `write_remote_roster` replaces `roster.json` wholesale (upstream #115161). Opening the app can wipe Desktop's roster. | #11 (shim the relay off on mobile). |
| 2 s room polling | The renderer calls `groups.state` and re-reads the whole log from `since_seq: 0` every 2 s while a room is visible. | #19 and #20 (`groups.event` plus paged incremental log); #32 stops polling in background. |
| Lost sends | Android kills background WebViews. Without `preparedSubmissions` in the bridge, the renderer falls back to `localStorage`, so an in-flight send can be lost or duplicated. | #12 (durable send journal); #15 (resume). |
| Two room drivers | Dashboard and gateway on one home both run a room service on `shared-state.db`; leases are per room. | #8 reports lease state; #28 soak-tests restarts of each process. |
| Slow upstream | #95163 and #126725 are labelled `needs-decision`. | Small feature-flagged PRs; carried patches (#16, #18). |

## 9. Where things live

| Item | Location |
|---|---|
| Plan | [`planning/PLAN.md`](../planning/PLAN.md) |
| Protocol contracts (G0) | [`planning/contracts/`](../planning/contracts/) |
| Issue drafts (source for #1–#33) | [`planning/issues.md`](../planning/issues.md), [`planning/issues.json`](../planning/issues.json) |
| One-page summary | [`planning/overview.html`](../planning/overview.html) |
| Gateway setup | [`docs/GATEWAY_SETUP.md`](GATEWAY_SETUP.md) |
| Issues | https://github.com/basilrari/hermes-mobile/issues |
| Verification notes | [`docs/VERIFICATION.md`](VERIFICATION.md) |

Upstream pins:

| Ref | Use |
|---|---|
| `450ad5055e` | **Current** renderer sync in `apps/desktop` and `apps/shared` (byte-identical, verified; see docs/ARCHITECTURE.md). |
| `7bda2a33` | The previous pin; an ancestor of `450ad5055e` with zero `apps/desktop` commits between. Origin citations in #36. |
| `4e59ac2b` | hermes-agent main read for the contracts (#35), doctor (#37), and setup guide (#38). |
| `acc3cada` | Named in `planning/PLAN.md`; not fetchable from the remote, so later work uses `4e59ac2b`. |

Upstream PRs and issues (NousResearch/hermes-agent):

| Number | What it is |
|---|---|
| [#49834](https://github.com/NousResearch/hermes-agent/pull/49834) | Bentlybro's Capacitor Android thin client; this repo's origin. Open. |
| [#52673](https://github.com/NousResearch/hermes-agent/pull/52673) | An alternative Expo/React Native shell (iOS-focused) for the Desktop renderer. Open. Reference only; reported to contain a leaked token, so copy nothing from it. |
| [#115161](https://github.com/NousResearch/hermes-agent/issues/115161) | Two Desktops on one gateway: the second `roster.sync` erases the first fleet. |
| [#139219](https://github.com/NousResearch/hermes-agent/issues/139219) | Desktop bots relay: roster attribution flaps; machine-root `bot_peers` gap. |
| [#95163](https://github.com/NousResearch/hermes-agent/issues/95163) | Backend-hosted group rooms (gateway round driver, authoritative log). Target of #19–#23. |
| [#126725](https://github.com/NousResearch/hermes-agent/issues/126725) | Cross-surface real-time conversation sync. |

## 10. Known gaps

- The published debug releases carry the old app ID; see "Not done yet".
- `planning/PLAN.md` still names `acc3cada`, which is not on the remote.
- Implementers of `groups.event` (#19): the upstream contract test only scans top-level `tui_gateway/*.py` for literal `_broadcast_global_event("groups.event", …)` calls, so put the emitter there.
