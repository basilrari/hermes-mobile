# hermes-mobile

An Android thin client for [Hermes Agent](https://github.com/NousResearch/hermes-agent).
It's a [Capacitor](https://capacitorjs.com) app that runs the **unmodified Hermes Desktop renderer**
in a WebView and talks to a **remote Hermes gateway** over HTTPS and WSS. That's the same
"Remote gateway" path the desktop app uses. The phone runs no agent, model or tools. Everything
runs on your gateway.

The app is based on [NousResearch/hermes-agent PR #49834](https://github.com/NousResearch/hermes-agent/pull/49834)
by [@Bentlybro](https://github.com/Bentlybro). See [LICENSE](LICENSE) for MIT terms and attribution.

Taking over the project? Start with [docs/HANDOFF.md](docs/HANDOFF.md).

> Status: M0 in progress. Unofficial, Android-only, HTTPS-only, app ID `io.github.basilrari.hermesmobile`, debug builds only.
>
> **v0.1.1**: the Desktop renderer is synced to upstream `hermes-agent` main
> (`7bda2a33`), so **Bot Mode** (the *Bots* tab next to *Sessions*) is included and works
> against a remote gateway. On tablets the left sidebar stays docked like the desktop app;
> on phones it opens as an edge overlay from the titlebar toggle.

## Repository layout

| Path | What it is |
|---|---|
| `apps/mobile` | The Capacitor app: bridge, connect/login screens, Android project |
| `apps/desktop` | Upstream Desktop renderer source (hermes-agent main `7bda2a33`), reused as-is through the `@/` alias (Electron main is not built) |
| `apps/shared` | Upstream shared gateway client (`@hermes/shared`) |
| `patches/` | `patch-package` fix for `@capacitor-community/safe-area` (IME double padding) |
| `docs/ARCHITECTURE.md` | How the pieces fit together |
| `docs/GATEWAY_SETUP.md` | Gateway setup on pavillion-claw (tailscale serve, password login, bot markers) |
| `scripts/gateway-doctor/` | Read-only gateway doctor |
| `docs/HANDOFF.md` | Project handoff: goal, decisions, rules, current state, next steps |
| `planning/` | Plan, issue drafts and one-page overview |

## One-time reinstall

The Android application id is `io.github.basilrari.hermesmobile`. The app name stays **Hermes**.

If you already installed a build with application id `com.nousresearch.hermesagent.mobile`, uninstall that app before installing this one. Android treats the new id as a different app, so the old app's data is not carried over. Sign in again after you install.

## Build a debug APK

Requirements: Node 22+, JDK 21, and the Android SDK (platform 36 and build-tools; set `ANDROID_HOME`).

```bash
npm ci --ignore-scripts        # lockfile is upstream's, so the renderer gets the exact dep versions it was tested with; skips Electron/node-pty native builds the mobile app doesn't need
npx patch-package              # applies patches/ (normally run by postinstall)
cd apps/mobile
npm run build                  # vite → apps/mobile/dist
npx cap sync android           # Capacitor CLI needs Node 22+
cd android && ./gradlew assembleDebug
# → apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`npm test` and `npm run typecheck` inside `apps/mobile` run the bridge unit tests, the application-id check, and the TypeScript check.

## Connecting to a gateway

1. On the machine that runs Hermes, publish the dashboard with `tailscale serve` so the phone
   reaches it at an `https://….ts.net` URL. The app accepts only `https://` gateway URLs.
2. In the app, enter that gateway URL, for example `https://my-box.tailnet-name.ts.net`.
3. The app probes `GET /api/status` and picks the auth mode:
   - **Token gateway**: paste the gateway's session token. You enter it at runtime and it's stored
     only on the device (Capacitor Preferences). It's never built into the APK.
   - **Login (OAuth/password) gateway**: sign in. The app keeps the session cookies and gets
     short-lived WebSocket tickets from `/api/auth/ws-ticket`.

### Recommended: Tailscale

Put both the gateway host and the phone on the same tailnet and publish the dashboard with
`tailscale serve`. **Don't port-forward the gateway to the public internet.**

## Security notes

- The repo contains no secrets. Tokens and passwords are entered at runtime only.
- The debug APK is signed with the standard Android debug key. Don't distribute it as a production build.
- `androidScheme` is `https`, so the WebView origin is `https://localhost`.
- Android does not permit cleartext traffic. The connect screen accepts only `https://` gateway URLs.
