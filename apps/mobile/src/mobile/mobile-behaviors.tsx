import { App } from '@capacitor/app'
import { Keyboard } from '@capacitor/keyboard'
import { useEffect } from 'react'
import { useLocation } from 'react-router'

import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'
import { $panesFlipped } from '@/store/layout'

/**
 * MobileBehaviors — the touch adaptations layered over the reused desktop UI.
 *
 * Layout is owned by the upstream pane tree:
 *  - At or above the desktop's sidebar-collapse breakpoint (640 CSS px — every
 *    tablet, in either orientation) the left rail stays DOCKED exactly like the
 *    desktop app, with its SESSIONS | BOTS tab strip. Nothing here touches it.
 *  - Below it (phones), collapsible rails leave the grid and the titlebar
 *    toggles reveal them as an edge overlay (`[data-narrow-overlay]`) that
 *    mirrors the zone's tab strip, so Bots is reachable there too.
 *
 * This component only adds phone ergonomics on top of that overlay:
 *  1. Navigating (selecting a session / bot) or tapping outside dismisses it.
 *  2. One Android back handler: keyboard → dismiss, else overlay → closed,
 *     else default (history back / exit).
 *  3. `data-drawer-open` on <html> while the overlay is up (CSS hides the
 *     fixed titlebar cluster that would otherwise float over it).
 *
 * The previous snapshot treated `$sidebarOpen === true` as "a drawer is open"
 * and closed it on every navigation/tap. On a tablet the docked rail is
 * always "open", so that logic collapsed the whole left sidebar — and with it
 * the Bots tab — on launch.
 */
function openOverlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-narrow-overlay]')
}
function anyDrawerOpen() {
  return openOverlay() !== null
}
function closeOpenDrawer() {
  const id = openOverlay()?.getAttribute('data-narrow-overlay')
  if (id) window.dispatchEvent(new CustomEvent(PANE_TOGGLE_REVEAL_EVENT, { detail: { id, mode: 'close' } }))
}

export function MobileBehaviors() {
  const location = useLocation()

  // Navigating (selecting a session / bot chat) dismisses an open overlay.
  useEffect(() => {
    if (anyDrawerOpen()) closeOpenDrawer()
  }, [location.pathname])

  useEffect(() => {
    // Standard orientation: sessions LEFT, files RIGHT.
    $panesFlipped.set(false)

    // Track keyboard visibility so the Android back button can dismiss it first.
    // (The WebView resizes above the keyboard natively; see patches/ for the
    // SafeArea IME fix.) Keyboard is native-only, so guard the web/dev path.
    let keyboardOpen = false
    const kbShow = Keyboard.addListener('keyboardWillShow', () => {
      keyboardOpen = true
    }).catch(() => null)
    const kbHide = Keyboard.addListener('keyboardWillHide', () => {
      keyboardOpen = false
    }).catch(() => null)

    const syncDrawerAttr = () => {
      document.documentElement.toggleAttribute('data-drawer-open', anyDrawerOpen())
    }
    const observer = new MutationObserver(syncDrawerAttr)
    observer.observe(document.body, { childList: true, subtree: true })
    syncDrawerAttr()

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      // Tap outside an open overlay → dismiss it (the overlay itself, and the
      // titlebar toggles that drive it, keep their own behaviour).
      if (
        anyDrawerOpen() &&
        !target?.closest('[data-narrow-overlay]') &&
        !target?.closest('[data-titlebar-cluster]')
      ) {
        e.stopPropagation()
        closeOpenDrawer()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)

    let backHandle: { remove: () => void } | undefined
    void App.addListener('backButton', ({ canGoBack }) => {
      if (keyboardOpen) {
        ;(document.activeElement as HTMLElement | null)?.blur()
        void Keyboard.hide()
        return
      }
      if (anyDrawerOpen()) {
        closeOpenDrawer()
        return
      }
      if (canGoBack) window.history.back()
      else void App.exitApp()
    })
      .then((h) => {
        backHandle = h
      })
      .catch(() => {})

    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', onPointerDown, true)
      backHandle?.remove()
      void kbShow.then((h) => h?.remove())
      void kbHide.then((h) => h?.remove())
      document.documentElement.removeAttribute('data-drawer-open')
    }
  }, [])

  // No UI — this component exists only for the side effects wired up above.
  return null
}
