/// <reference types="vite/client" />

/** Injected by vite.config.ts (`define`) from apps/mobile/package.json. */
declare const __HERMES_APP_VERSION__: string

interface ImportMetaEnv {
  readonly VITE_HERMES_TRACE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

