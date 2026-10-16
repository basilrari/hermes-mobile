// 1) Install the window.hermesDesktop bridge BEFORE any vendored desktop module
//    evaluates (this import must stay first — see bridge/boot.ts).
import '~bridge/boot'

// 2) Design system + mobile structural CSS. ./styles.css inlines the desktop
//    design system AND adds the Tailwind @source for the desktop renderer.
import './styles.css'
import '~mobile/theme-fallback.css'

// 2b) Mobile-only wording overrides (touch gestures vs mouse/keyboard). Side
//     effect; must run before the I18nProvider reads the catalog.
import '~mobile/i18n-overrides'

// 3) Desktop side-effect: persisted translucency (native calls are optional-chained).
import '@/store/translucency'
import '@/store/user-bubble-transparency'
import '@/store/chat-text-scale'

import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'

// Reuse the desktop's own providers so the mobile app shares its exact runtime:
// query cache, i18n, theme tokens, haptics, routing.
import { RootErrorBoundary } from '@/components/error-boundary'
import { HapticsProvider } from '@/components/haptics-provider'
import { ProfileI18nProvider as I18nProvider } from '@/i18n/profile-provider'
import { installClipboardShim } from '@/lib/clipboard'
import { queryClient } from '@/lib/query-client'
import { RootTooltipProvider } from '@/components/ui/tooltip'
import { ThemeProvider } from '@/themes/context'

import { MobileRoot } from './app'
import { TraceBadge } from '~mobile/TraceBadge'

installClipboardShim()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ThemeProvider>
            <HapticsProvider>
              <RootTooltipProvider>
                <HashRouter useTransitions={false}>
                  <MobileRoot />
                  <TraceBadge />
                </HashRouter>
              </RootTooltipProvider>
            </HapticsProvider>
          </ThemeProvider>
        </I18nProvider>
      </QueryClientProvider>
    </RootErrorBoundary>
  </StrictMode>,
)
