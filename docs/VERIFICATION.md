# Verification status (v0.1.1-debug)

## What changed

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

## Verified

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

## Not verified

- On a physical Android tablet/WebView (no KVM-capable emulator on the build box; see v0.1.0 notes).
  The browser run uses `fetch` instead of CapacitorHttp; the native HTTP/cookie path is unchanged
  from v0.1.0.
- Real LLM turns (the test gateway had no inference provider configured).
