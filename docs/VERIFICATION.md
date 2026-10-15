# Verification status (v0.1.0-debug)

Verified:
- `./gradlew assembleDebug` builds `app-debug.apk` (package `com.nousresearch.hermesagent.mobile`, minSdk 24, targetSdk 36).
- `apksigner verify` passes (Android Debug certificate); `aapt dump badging` OK; bundled renderer present under `assets/public/`.
- APK installs (`adb install` → Success) and `MainActivity` launches on an API 35 x86_64 emulator.
- A real Hermes gateway (`hermes dashboard`, v0.18.2, token mode) with a mock OpenAI-compatible LLM answered a full
  token-authenticated WebSocket chat round-trip (`session.create` → `prompt.submit` → `message.complete`) from a host-side test client.

NOT verified:
- The chat UI rendering inside the app. On the build box, KVM-accelerated boot stalled (nested virtualization), and under
  software emulation (TCG) the Android System WebView renderer crashes with SIGTRAP during page load (also with `--jitless`),
  so the Capacitor WebView never painted. This looks like an emulator/CPU-emulation problem, not an app defect, but it
  has not been ruled out. Test on a real device or a KVM-capable emulator.
- An in-app connection to a gateway at 10.0.2.2 and sending a chat message from the app.

Screenshots: `verify/01-launch.png` … `verify/05-app.png` (system ANR dialogs / crash; no app UI).
