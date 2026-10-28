/**
 * stubs.ts — safe no-op implementations for the parts of the window.hermesDesktop
 * contract that don't apply to a remote mobile client: local terminal (xterm),
 * self-update, uninstall, first-launch bootstrap, multi-window, local filesystem,
 * VS Code theme marketplace, etc.
 *
 * These exist so vendored desktop code that reaches for them gets a defined,
 * harmless response instead of `undefined is not a function`. Subscription-style
 * methods return a real unsubscribe.
 */

import { dialSuppressedRecently } from './socket-lifecycle'

const noopUnsub = (): void => {}

// A tiny "already booted, nothing to do" progress object. `retryable` is optional
// so the gate branch below keeps the same shape (see getBootProgress).
const readyBoot: { retryable?: boolean } & Record<string, unknown> = {
  error: null,
  fakeMode: false,
  message: 'Connected',
  phase: 'ready',
  progress: 1,
  running: false,
  timestamp: 0,
}

const unsupportedWindow = { ok: false, error: 'unsupported-on-mobile' }

/** Build the stub half of the bridge. Loosely typed; install-bridge merges the
 *  real methods over it and casts the result to the contract. */
export function makeStubs() {
  return {
    revalidateConnection: async () => ({ ok: true, rebuilt: false }),
    touchBackend: async () => ({ ok: true }),

    // Multi-window → handled by in-app routing on mobile.
    openSessionWindow: async () => unsupportedWindow,
    openNewSessionWindow: async () => unsupportedWindow,

    // Boot / bootstrap: there is no local backend to install on a phone.
    // `retryable` is what `bootFailureIsRetryable` reads (use-gateway-boot.ts).
    // A boot dial refused by the HM-32 gate is transient, so the boot takes the
    // hook's retry loop instead of failing with a sticky "Hermes couldn't start"
    // toast whose detail line is the internal suppression string.
    //
    // Cause, not time: `isSuspended()` answers for the whole hidden window, so it
    // would also make a genuine 401 during a backgrounded boot look transient —
    // the one class the hook reserves for remote faults. The gate records its own
    // refusal (connection.ts → noteDialSuppressed), and only a refusal fresh
    // enough to belong to this failure counts.
    //
    // Reach, honestly: that loop is 5 attempts at full jitter with ceilings
    // 2/4/8/15/15 s, so it bridges ~22 s typically and 44 s worst case. A phone
    // left hidden longer still reaches `failDesktopBoot` while it is hidden;
    // BootAutoRetry (`mobile/boot-auto-retry.tsx`) then holds the reload until the
    // screen is back (`boot-reload.ts`), and after 60 s hidden drops its
    // "Reconnecting…" cover so
    // the manual failure screen is reachable — without reloading blind, because a
    // reload starts a fresh bridge with the gate `false` and would dial.
    // Widening the budget itself would need a vendored patch.
    // Left `undefined` (the previous value) for every other failure.
    getBootProgress: async () => (dialSuppressedRecently() ? { ...readyBoot, retryable: true } : readyBoot),
    onBootProgress: () => noopUnsub,
    getBootstrapState: async () => ({
      active: false,
      manifest: null,
      stages: {},
      error: null,
      log: [],
      startedAt: null,
      completedAt: null,
      unsupportedPlatform: null,
    }),
    resetBootstrap: async () => ({ ok: true }),
    repairBootstrap: async () => ({ ok: true }),
    cancelBootstrap: async () => ({ ok: true, cancelled: false }),
    onBootstrapEvent: () => noopUnsub,

    // Connection-config UI (desktop Settings → Gateway). Mobile owns its own
    // connect/login screens, so these return inert defaults.
    // Shape is DesktopConnectionConfig (v0.22.5 added the keychain, cloud and
    // ssh fields). Mobile never persists a desktop connection.json; these are
    // the inert defaults the settings screens read.
    getConnectionConfig: async () => ({
      envOverride: false,
      mode: 'remote' as const,
      profile: null,
      remoteAuthMode: 'oauth' as const,
      remoteOauthConnected: true,
      remoteTokenPreview: null,
      remoteTokenSet: false,
      secureTokenStorage: false,
      remoteTokenPlainText: false,
      remoteUrl: '',
      cloudOrg: '',
      sshHost: '',
      sshUser: '',
      sshPort: null,
      sshKeyPath: '',
      sshRemoteHermesPath: '',
      sshRemoteProfile: '',
    }),
    saveConnectionConfig: async (p: unknown) => p,
    applyConnectionConfig: async (p: unknown) => p,
    testConnectionConfig: async () => ({ baseUrl: '', ok: true, version: null }),
    probeConnectionConfig: async (remoteUrl: string) => ({
      baseUrl: remoteUrl,
      reachable: false,
      authMode: 'oauth' as const,
      providers: [],
      version: null,
      error: 'use the mobile connect screen',
    }),
    oauthLoginConnectionConfig: async (remoteUrl: string) => ({
      ok: false,
      baseUrl: remoteUrl,
      connected: false,
    }),
    oauthLogoutConnectionConfig: async () => ({ ok: true, connected: false }),

    // No desktop profile preference. `getDefault` returns null so the renderer
    // does not restore a route this shell never saved. The methods exist
    // because v0.22.5's profile object requires them; absence is feature-detected
    // as "older shell", which is also fine, but a present no-op matches the
    // contract without inventing a saved route.
    profile: {
      get: async () => ({ profile: null }),
      set: async (name: string | null) => ({ profile: name }),
      getDefault: async () => null,
      setDefault: async (route: { connectionId: null | string; profile: string }) => route,
      onDefaultChanged: () => noopUnsub,
      remember: async (name: string | null) => ({ profile: name }),
    },

    requestMicrophoneAccess: async () => true,

    // Local filesystem (desktop-only). Remote files come via /api/files later.
    readFileDataUrl: async () => '',
    readFileText: async (filePath: string) => ({ path: filePath, text: '' }),
    selectPaths: async () => [] as string[],
    readDir: async () => ({ entries: [] }),
    getPathForFile: () => '',
    sanitizeWorkspaceCwd: async (cwd?: null | string) => ({ cwd: cwd ?? '', sanitized: false }),

    // Image capture/save (Phase 4).
    saveImageFromUrl: async () => false,
    saveImageBuffer: async () => '',
    saveClipboardImage: async () => '',

    // Link / preview helpers.
    fetchLinkTitle: async () => '',
    normalizePreviewTarget: async () => null,
    watchPreviewFile: async (url: string) => ({ id: '', path: url }),
    stopPreviewFileWatch: async () => true,
    onPreviewFileChanged: () => noopUnsub,
    onClosePreviewRequested: () => noopUnsub,

    settings: {
      getDefaultProjectDir: async () => ({ defaultLabel: '', dir: null, resolvedCwd: '' }),
      pickDefaultProjectDir: async () => ({ canceled: true, dir: null }),
      setDefaultProjectDir: async (dir: null | string) => ({ dir }),
    },

    revealLogs: async () => ({ ok: false, path: '', error: 'unsupported-on-mobile' }),
    getRecentLogs: async () => ({ path: '', lines: [] as string[] }),

    // Local PTY terminal — not ported to mobile.
    terminal: {
      dispose: async () => true,
      onData: () => noopUnsub,
      onExit: () => noopUnsub,
      resize: async () => true,
      start: async () => ({ cwd: '', id: '', shell: '' }),
      write: async () => true,
    },

    onBackendExit: () => noopUnsub,

    getVersion: async () => ({
      appVersion: '0.2.0',
      electronVersion: '',
      nodeVersion: '',
      platform: 'capacitor',
      hermesRoot: '',
    }),

    updates: {
      check: async () => ({ supported: false, reason: 'managed-on-server' }),
      apply: async () => ({ ok: false, error: 'managed-on-server' }),
      getBranch: async () => ({ branch: '' }),
      setBranch: async (name: string) => ({ branch: name }),
      onProgress: () => noopUnsub,
    },

    uninstall: {
      summary: async () => ({
        code_removal_allowed: false,
        native_removal_instructions: null,
        hermes_home: '',
        agent_installed: false,
        gui_installed: false,
        source_built_artifacts: [],
        packaged_app_paths: [],
        userdata_dir: '',
        userdata_exists: false,
        platform: 'capacitor',
      }),
      run: async () => ({ ok: false, error: 'unsupported-on-mobile' }),
    },

    // ── Desktop-shell members the v0.22.5 renderer contract names.
    // Inert on a phone/tablet.
    //
    // `connections` (the v2 multi-connection registry) is intentionally absent.
    // `hasRegistryTopology()` is true as soon as `connections.list` exists, and
    // session owner resolution then fail-closes unless every row is stamped
    // with a registry id. Mobile is one remote gateway — the legacy topology
    // the renderer still takes when the registry bridge is missing
    // (`refreshConnectionsRegistry` returns null). A stub registry would flip
    // that and break session resume. Do not add one.
    openSessionInTerminal: async () => unsupportedWindow,
    openWindow: async () => unsupportedWindow,
    openBrowserWindow: async () => unsupportedWindow,
    onBrowserPopoutClosed: () => noopUnsub,
    // Single window: this window always wins a cross-window ambient cue.
    claimAmbientCue: async () => true,
    windowControls: { custom: false, minimize: () => {}, toggleMaximize: () => {}, close: () => {} },
    petOverlay: {
      open: async () => ({ ok: false }),
      close: async () => ({ ok: true }),
      setBounds: () => {},
      setIgnoreMouse: () => {},
      setFocusable: () => {},
      pushState: () => {},
      control: () => {},
      onState: () => noopUnsub,
      onControl: () => noopUnsub,
    },
    quickEntry: {
      getSettings: async () => ({ enabled: false, registered: false, shortcut: '', supported: false }),
      setSettings: async () => ({ enabled: false, registered: false, shortcut: '', supported: false }),
      submit: async () => ({ ok: false }),
      ackSubmit: () => {},
      dismiss: () => {},
      pushState: () => {},
      onState: () => noopUnsub,
      onSubmit: () => noopUnsub,
      onShown: () => noopUnsub,
      onLateResult: () => noopUnsub,
    },
    getSecretStorageEncryption: async () => ({ on: false }),
    setSecretStorageEncryption: async () => ({ on: false }),
    sshConfigHosts: async () => ({ hosts: [] }),
    sshResolveHost: async (host: string) => ({ ok: false, host, error: 'unsupported-on-mobile' }),
    cloud: {
      status: async () => ({ loggedIn: false }),
      login: async () => ({ ok: false, loggedIn: false }),
      logout: async () => ({ ok: true, loggedIn: false }),
      discover: async () => ({ ok: false, agents: [], error: 'unsupported-on-mobile' }),
      agentSignIn: async () => ({ ok: false, error: 'unsupported-on-mobile' }),
    },
    readClipboard: async () => '',
    savePastedText: async () => '',
    continueBootstrapLocal: async () => ({ ok: false }),
    updateHold: {
      recheck: async () => ({ ok: true }),
      quit: async () => ({ ok: false }),
      startAnyway: async () => ({ ok: true }),
    },
    getSyncStatus: async () => null,
    findInPage: async () => ({ count: 0 }),
    stopFindInPage: async () => {},
    onFoundInPage: () => noopUnsub,
    onOpenFindBarRequested: () => noopUnsub,

    themes: {
      fetchMarketplace: async (id: string) => ({ extensionId: id, displayName: '', themes: [] }),
      searchMarketplace: async () => [],
    },
  }
}
