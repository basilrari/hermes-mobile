import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.github.basilrari.hermesmobile',
  appName: 'Hermes',
  webDir: 'dist',
  // Bridge-wide logging is OFF, on every build type. `CapConfig.java` maps
  // 'production' -> loggingEnabled = true, 'none' -> false, and a missing key (or
  // 'debug') -> `isDebug`, which is TRUE in a debuggable APK — and this repo only
  // builds `assembleDebug`. With the logger on, `Bridge.callPluginMethod` writes
  // every plugin payload to logcat: the CapacitorHttp request (Cookie /
  // X-Hermes-Session-Token headers and the login password body) plus the
  // saved-token Preferences values. So 'none' is the only value that is off in the
  // APK we actually produce. The "control switched itself off" signal goes through
  // the RPC trace instead — metadata only — see src/bridge/lifecycle-gap.ts.
  loggingBehavior: 'none',
  // CapacitorHttp routes the bridge's REST calls (login + ws-ticket) through
  // the NATIVE HTTP stack, which bypasses the browser CORS that the gateway
  // locks to localhost — the whole reason a plain PWA can't talk to a remote
  // gateway but this app can. See src/bridge/http.ts.
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    // Makes env(safe-area-inset-*) report the REAL system-bar insets on Android
    // edge-to-edge (the system WebView otherwise only reports display cutouts).
    // Used ONLY to push the titlebar below the status bar — see theme-fallback.css.
    // LIGHT = dark bar icons, matching the default light theme.
    SafeArea: {
      // Initial icon styles (before JS runs) for the default light theme: LIGHT =
      // dark icons on a light background. Both bars are re-synced at runtime to the
      // active app theme via SafeArea.setSystemBarsStyle — see native-init.ts. The
      // bar BACKGROUNDS stay transparent so the themed app background shows behind.
      statusBarStyle: 'LIGHT',
      navigationBarStyle: 'LIGHT',
    },
    // Keyboard is used only for its JS events (keyboardWillShow/Hide) and
    // Keyboard.hide() — see mobile-behaviors. The actual resize-above-keyboard is
    // done natively by Chromium on Android edge-to-edge; the SafeArea plugin is
    // patched (patches/@capacitor-community+safe-area) so it doesn't ALSO pad for
    // the IME, which used to double-collapse the viewport (innerHeight 914 → 241).
    Keyboard: {
      resize: 'none',
    },
  },
  server: {
    // WebView origin is https://localhost. Gateway traffic is https:// and wss://
    // only; Android cleartext is off (network_security_config.xml).
    androidScheme: 'https',
  },
}

export default config
