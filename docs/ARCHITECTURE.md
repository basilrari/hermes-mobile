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
