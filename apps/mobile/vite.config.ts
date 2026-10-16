import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { hermesMobileRelayOverride } from './src/overrides/relay-override'

// Resolve a path relative to this config file.
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// The app version shown in the debug trace badge (HM-05).
const pkg = JSON.parse(fs.readFileSync(r('./package.json'), 'utf8')) as { version: string }

// Resolve packages from the desktop workspace (mirrors upstream apps/desktop/vite.config.ts)
// so react/react-dom/driver.js are the exact copies the renderer was built against.
const requireFromDesktop = createRequire(r('../desktop/vite.config.ts'))
const reactDir = path.dirname(requireFromDesktop.resolve('react/package.json'))
const reactDomDir = path.dirname(requireFromDesktop.resolve('react-dom/package.json'))
const driverIife = path.join(path.dirname(requireFromDesktop.resolve('driver.js')), 'driver.js.iife.js')

// The emoji picker fetches `<base>/emojibase/<locale>/data.json`; ship the en files offline.
const emojibaseDir = path.dirname(requireFromDesktop.resolve('emojibase-data/package.json'))
const emojibaseAssets = () => ({
  name: 'hermes:emojibase-assets',
  generateBundle(this: { emitFile: (a: { type: 'asset'; fileName: string; source: Uint8Array }) => void }) {
    for (const rel of ['en/data.json', 'en/messages.json', 'en/shortcodes/emojibase.json']) {
      this.emitFile({ type: 'asset', fileName: `emojibase/${rel}`, source: fs.readFileSync(path.join(emojibaseDir, rel)) })
    }
  }
})

// The upstream renderer is built with the React Compiler (apps/desktop/vite.config.ts)
// and some components rely on its memoization — e.g. external-store selectors that
// would otherwise return a fresh snapshot every render ("Maximum update depth
// exceeded … getSnapshot should be cached"). Run the same pass, same filter.
function compilerPreset() {
  const preset = reactCompilerPreset()
  preset.rolldown.filter.code = /\/>|<\/|from\s*['"][^'"]*react/
  return preset
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Mobile overrides (HM-11): swap the Desktop bot relay for a no-op. Must run
    // before the default resolver, hence enforce:'pre' inside the plugin.
    hermesMobileRelayOverride(r('./src/overrides/hermes-bots-relay.ts')),
    react(),
    babel({ presets: [compilerPreset()] }),
    tailwindcss(),
    emojibaseAssets(),
  ],
  define: { __HERMES_APP_VERSION__: JSON.stringify(pkg.version) },
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      // Dev-only perf counters are aliased out of non-dev builds upstream too.
      '@/debug/dev-only': r('../desktop/src/debug/dev-only.noop.ts'),
      // The desktop renderer references itself via `@/...`; point that at the
      // desktop workspace source so its components run here UNMODIFIED — no
      // vendoring. The mobile bridge also uses `@/global` etc. via this alias.
      '@': r('../desktop/src'),
      '@hermes/plugin-sdk': r('../desktop/src/sdk/index.ts'),
      // Shared gateway client (workspace package).
      '@hermes/shared/billing': r('../shared/src/billing-types.ts'),
      '@hermes/shared/color': r('../shared/src/color.ts'),
      '@hermes/shared': r('../shared/src'),
      'driver.js/dist/driver.js.iife.js?raw': `${driverIife}?raw`,
      'driver.js/dist/driver.js.iife.js': driverIife,
      react: reactDir,
      'react-dom': reactDomDir,
      'react/jsx-dev-runtime': path.join(reactDir, 'jsx-dev-runtime.js'),
      'react/jsx-runtime': path.join(reactDir, 'jsx-runtime.js'),
      // Mobile-only (net-new) code.
      '~mobile': r('./src/mobile'),
      '~bridge': r('./src/bridge'),
    },
    dedupe: ['react', 'react-dom', 'react-router', '@tanstack/react-query'],
  },
  server: {
    host: '127.0.0.1',
    port: 5180,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 25000,
  },
})
