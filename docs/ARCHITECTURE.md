# Architecture

```
┌──────────── Android device ────────────┐          ┌──────── your host ────────┐
│ Capacitor WebView (origin https://localhost)       │                           │
│  ┌──────────────────────────────────┐  │  HTTP    │  Hermes gateway/dashboard │
│  │ Desktop renderer (apps/desktop/src)│ ├─────────►│  /api/status, /auth/*,    │
│  │  unmodified React UI              │  │ (native  │  /api/auth/ws-ticket, …   │
│  └──────────────┬───────────────────┘  │  HTTP)   │                           │
│                 │ window.hermesDesktop │  WS      │  /api/ws (chat stream)    │
│  ┌──────────────▼───────────────────┐  ├─────────►│                           │
│  │ Bridge (apps/mobile/src/bridge)   │  │          └───────────────────────────┘
│  └───────────────────────────────────┘  │          (ideally over Tailscale)
│  Capacitor plugins: Http, Preferences,  │
│  SafeArea, Keyboard, App, Share, …      │
└─────────────────────────────────────────┘
```

## The key idea

In Electron, the Desktop renderer talks to the main process through `window.hermesDesktop`
(preload IPC). On mobile there's no main process, so `apps/mobile/src/bridge` **installs a
browser-side implementation of `window.hermesDesktop`** before the renderer boots:

- `install-bridge.ts` / `boot.ts` install the bridge object, then load the renderer.
- `http.ts` handles `api` calls. These go through **CapacitorHttp**, the native Android HTTP
  stack, which gets around the browser CORS policy that locks the gateway to localhost. That's
  why a plain PWA can't do this and the app can.
- `auth.ts` runs the probe → login → WS ticket flow, mirroring `hermes_cli/dashboard_auth`.
- `connection-config.ts` handles URL normalization, auth-mode classification and WS URL
  building. It's a port of `apps/desktop/electron/connection-config.cjs`.
- `connection.ts` resolves the WebSocket URL. It uses `?ticket=` for OAuth and `?token=` for
  token gateways.
- `cookie-jar.ts` persists the session cookies per gateway in Preferences.
- `state.ts` stores the saved gateway target in Preferences.
- `stubs.ts` provides no-op or best-effort versions of desktop-only APIs (windows, local
  files, updater, …).
- `native.ts` wraps Capacitor plugins (clipboard, share, haptics, notifications, …).

`apps/mobile/src/mobile` contains the net-new mobile UI: the connect, token and login screens,
safe-area/keyboard behaviours, a theme fallback and i18n overrides. `app.tsx` shows the
connect flow until a target is saved, then mounts the Desktop renderer.

## Build wiring

- `vite.config.ts` aliases `@` → `../desktop/src` and `@hermes/shared` → `../shared/src`, so
  the desktop components compile into the mobile bundle without being copied or forked.
- `capacitor.config.ts`: `webDir: dist`, CapacitorHttp enabled, `androidScheme: 'https'`.
  The WebView origin is `https://localhost`. Gateway traffic is `https://` and `wss://` only.
- The Android project lives in `apps/mobile/android`, a standard Capacitor 8 Gradle project.

## Scope and what's left out of this repo

From upstream we kept only what the mobile app needs: `apps/mobile`,
`apps/desktop` renderer source plus `electron/` (the renderer imports types and config from it),
`apps/shared`, and the safe-area patch. We left out the Python agent, TUI, web dashboard,
installer, desktop packaging scripts and PR screenshots.

## Renderer sync (HM-16)

`apps/desktop` and `apps/shared` are **copies of upstream**, not a fork: no local edits,
ever. They are pinned to a SHA and refreshed at the start of each milestone and after an
Eng B upstream PR merges.

| Pin | SHA | Verified |
|---|---|---|
| Renderer + shared | `450ad5055e` (`NousResearch/hermes-agent` main, 2026-10-15) | `apps/desktop/src` and `apps/shared/**` byte-identical to upstream at that SHA; the five upstream-only directories (`docs/`, `e2e/`, `packaging/`, `pr-assets/`, `preview-demo.html`) are intentionally not vendored. The previous pin `7bda2a33` is an ancestor of it with **zero** `apps/desktop` commits between, so no resync was needed. |

The `package-lock.json` at the root is **this repo's** workspace lockfile (the root
`package.json` declares `workspaces`), so it legitimately differs from upstream's; it is
regenerated with `npm install`, not copied from a sync.

There are two mechanisms for living with a renderer we do not edit:

1. **Mobile overrides** — a Vite `resolveId` rule that swaps one upstream module for a
   mobile one, for a module whose *behaviour* is wrong on a phone. The desktop source stays
   untouched; the override is the only place the difference lives.
2. **Carried upstream patches** — `patches/upstream/*.patch`, applied by
   `scripts/apply-upstream-patches.mjs`, for a fix that belongs upstream and is on its way
   there. See [`patches/upstream/README.md`](../patches/upstream/README.md).

### Mobile overrides

Every override is registered in `apps/mobile/vite.config.ts` and must have a row here.
"Removal condition" is the event that lets the override be deleted.

| Override | Replaces | Why | Removal condition |
|---|---|---|---|
| `src/overrides/hermes-bots-relay.ts` (HM-11) | `plugins/hermes-bots/plugin.tsx`'s `./relay` import | The Desktop bot relay publishes each gateway the roster of agents on its **other** connections. Mobile has one connection, so it publishes an **empty** roster and `write_remote_roster` replaces `roster.json` wholesale (upstream #115161) — opening the app could wipe a Desktop's roster. | Upstream stops publishing an empty roster for a sole connection (#115161). |

