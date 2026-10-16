# Verification status

Two records: what v0.1.1 proved, and what Option D has proved since. Every line
below is a command that was run, not an expectation.

## Option D (current)

Branch `main`, renderer pinned to `NousResearch/hermes-agent` `450ad5055e`
(see `docs/ARCHITECTURE.md` → Renderer sync).

### Automated, on the box

| Check | Command | Result |
|---|---|---|
| Bridge unit tests | `cd apps/mobile && npm test` | **85 passed** (7 files) |
| Types | `cd apps/mobile && npm run typecheck` | 0 errors |
| End-to-end harness | `npm run e2e` | **47/47 checks** at 412×915, 915×412, 800×1280, 1280×800 |
| Gateway doctor | `cd scripts/gateway-doctor && python3 -m unittest test_doctor.py` | 31 tests |
| Secret scan | `gitleaks detect --source . --config .gitleaks.toml` | no leaks (full history) |
| Carried patches | `node scripts/apply-upstream-patches.mjs --check --self-test` | clean (no patches carried) |
| Android debug APK | `npm run apk:debug` | builds (see the gap below) |

What the harness actually asserts per viewport: the connect screen renders; an
`http://` gateway is refused; token login reaches the chat shell; the **Bots
roster** surface is reachable (docked at ≥640 px, or via the titlebar's *Show
sidebar* on a phone); the RPC trace is live and shows **zero `bot_relay.*`**
calls; `preparedSubmissions` is exposed and the renderer's own `localStorage`
fallback is empty; `deviceIdentity()` returns a v4 uuid; **no conversation state
is in `localStorage`**; and the device id is unchanged across a page reload
(a relaunch). Plus one two-concurrent-client pass.

CI on every pull request: `review-gate` (required — the merge control), and
`secrets` / `app tests` / `carried upstream patches` as reported checks.

### Not verified

- **A physical Android tablet.** No KVM emulator on the box and, per rule 2, the
  gateway password does not leave Basil's machine. A browser run uses `fetch`
  instead of CapacitorHttp, so native HTTP, the native cookie path, and the
  Android lifecycle are **not** covered here. They are Basil's tablet checklist
  (`docs/checklists/`).
- **Password/`Set-Cookie` login in a browser.** The bridge's cookie capture is
  native-only by design (`cookie-jar.ts`); the harness therefore logs in through
  a token gateway. Basil's tablet checklist covers the password path.
- **Hosted rooms.** No room is opened anywhere in the harness — that needs a
  room-capable gateway, which is the HM-26 integration path. Consequently
  `groups.event` / read cursors, the send-journal round trip, and the room-only
  `localStorage` keys are **not** exercised yet (HM-13 records this).
- **Real LLM turns.** The harness runs 0 turns against the mock; a real reply is
  Basil's checklist item, capped at DeepSeek Flash within the $5/month budget.
- **pavillion-claw.** Every check above ran against the in-process mock gateway
  or the local box. The real-gateway run is `HERMES_E2E_GATEWAY_URL=… npm run e2e`
  on Basil's machine.

## v0.1.1-debug (historical)

### What changed

- `apps/desktop` + `apps/shared` synced to NousResearch/hermes-agent main `7bda2a33` (the PR #49834
  snapshot predated Bot Mode: no `src/plugins/hermes-bots`, no plugin SDK/contrib loader).
- Root `package-lock.json` is upstream's, so transitive deps match (a drifted `@assistant-ui/tap`
  0.9.23 caused a "Maximum update depth exceeded" render loop).
- Mobile Vite build mirrors upstream's: React Compiler pass, `@hermes/plugin-sdk` and
  `@hermes/shared/*` aliases, `driver.js` IIFE alias, react dedupe, offline emojibase assets.
- Bridge: `getConnection()` now carries a stable `connectionId` (Bot Mode canonical groups and
  route-scoped requests require it); new `getConnectionFor` / `getGatewayWsUrlFor` (resolve to the
  primary socket with `sharedRemote: true`), `getProfileRoutes`; stubs for the other members the new
  renderer contract requires; REST/WS calls issued before the saved target loads now wait for it.
- `MobileBehaviors`: only treats the narrow (<640px) edge overlay as a drawer. The old logic
  closed the *docked* sidebar on launch/navigation/tap, hiding Sessions | Bots on tablets.

### Verified then

- `npm test` (apps/mobile): 35 bridge tests pass (3 files, incl. new `registry.test.ts`).
- `npm run typecheck` (apps/mobile): 0 errors.
- `./gradlew assembleDebug` → `app-debug.apk` (versionName 0.1.1, versionCode 2), `apksigner verify` OK.
- The APK's bundled JS (`assets/public/assets/index-*.js`) contains the `hermes-bots` plugin (no
  `defaultEnabled:false`, so on by default), its left pane docked as a center tab into `sessions`,
  and the bridge's `sharedRemote` routing.
- The same built bundle in headless Chrome against a real upstream `hermes dashboard` (basic auth,
  password login, via a same-origin proxy):
  - 1280×800 and 800×1280 (tablet): left sidebar docked with **SESSIONS | BOTS** tabs.
  - 412×915 (phone): titlebar toggle opens the edge overlay with the same tabs.
  - Bots roster lists the gateway's profiles; clicking a bot opens its canonical chat; **New Bot**
    created profile `mobile-test` on the gateway with the `ui_meta: { hermes-bots: … }` marker.

### Not verified then

- On a physical Android tablet/WebView (no KVM-capable emulator on the build box).
- Real LLM turns (the test gateway had no inference provider configured).
