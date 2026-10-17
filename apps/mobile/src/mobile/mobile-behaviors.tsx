import { App } from '@capacitor/app'
import { Keyboard } from '@capacitor/keyboard'
import { useEffect } from 'react'
import { useLocation } from 'react-router'

import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'
import { translateNow } from '@/i18n'
import { $panesFlipped } from '@/store/layout'
import { $notifications, dismissNotification } from '@/store/notifications'
import { onAppStateChange } from '~bridge/native'
import { isGatewayWsUrl } from '~bridge/connection-config'
import { onSocketCreated, setSuspended, type SocketLike } from '~bridge/socket-lifecycle'
import { staleConnectionLostIds } from '~bridge/stale-alerts'

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

    // HM-32: close the gateway socket when the app leaves the screen, and close
    // one the renderer opens while it is still hidden. Resume only clears the flag.
    //
    // The flag is a module global, and this effect owns the only `appStateChange`
    // listener that clears it. A 401 while hidden unmounts this component
    // (http.ts → requireReauth → app.tsx leaves the connected tree) and the
    // plugin does not replay `isActive: true` to the listener the next login
    // mounts, so a stale `true` would gate every dial on a visible app. Clear it on
    // MOUNT only: that is what a remount while active needs, and it is the clear
    // that closes the stuck-flag failure. Clearing on unmount too would open the
    // gate on a phone that is still hidden — the 401 path unmounts this component
    // in the background, and the resolver outlives it (`store/profile.ts`,
    // `api/plugins.ts`, `store/gateway.ts` all reach `getConnectionFor`), so a dial
    // there would mint a ticket behind a screen nobody is looking at. The two
    // headers that promise "no socket stays open while hidden, including on the
    // failure path" (`socket-lifecycle.ts`, `connection.ts`) are unconditional, and
    // an unmount clear contradicts them (round 14).
    setSuspended(false)
    //
    // While hidden, every ladder step is a failed attempt (the gate in
    // connection.ts), so the vendored boot hook's 300 s escalation raises a
    // "Hermes lost its connection" toast with `durationMs: 0` — no timer, and
    // nothing on the reconnect path dismisses it. So: on the next socket OPEN,
    // drop the connection-lost alerts that were raised at or after this
    // background edge, then forget the edge (one shot per hidden window). Not on
    // resume: coming back on screen does not prove the gateway is reachable, and a
    // remaining toast is the only actionable thing ("Reconnect now") a user has
    // while the gateway is still down. Resume only clears the suspend flag.
    let hiddenAtMs = 0
    // The `open` listeners this mount attaches, so the cleanup can take them off
    // again. `removeOpenWatch()` only drops the observer: a socket it already saw
    // keeps the listener, and that closure holds the URL (which may carry
    // `?token=`) and can still write to the store from a dead mount (round 26 S2).
    const boundOpenListeners: { socket: SocketLike; onOpen: () => void }[] = []
    const dismissHiddenToasts = (): void => {
      if (hiddenAtMs === 0) return
      const title = translateNow('boot.errors.gatewayConnectionLost')
      for (const id of staleConnectionLostIds($notifications.get(), title, hiddenAtMs)) {
        dismissNotification(id)
      }
      // One shot per hidden window. Without this the timestamp outlives its
      // window and the rule silently means "any alert since the first background",
      // which is not what `stale-alerts.ts` documents (round 8).
      hiddenAtMs = 0
    }

    const removeAppState = onAppStateChange((active) => {
      setSuspended(!active)
      if (!active) hiddenAtMs = Date.now()
    })

    // A GATEWAY socket that opens is proof the connection is fine, so any
    // connection-lost toast raised while we were hidden is stale by definition.
    // Scoped two ways on purpose: only the gateway route counts — sibling sockets
    // (plugin streams, dictation, Bot Screen RFB) open beside it on other paths and
    // their `open` is not evidence about the gateway (`isGatewayWsUrl`) — and only
    // the window the app was hidden for, so a toast raised on a visible app is left
    // alone. The observer sees every socket the wrapper builds, hence the check.
    const removeOpenWatch = onSocketCreated((socket, url) => {
      const onOpen = (): void => {
        // `url` is the one the wrapper constructed the socket with — the same
        // value the close rule uses. `SocketLike` does not declare `url` at all
        // any more (rounds 23-25), so reading it here would leave the dismissal
        // blind to exactly the shape the close handles (round 24 S1).
        if (isGatewayWsUrl(url)) dismissHiddenToasts()
      }
      socket.addEventListener('open', onOpen)
      boundOpenListeners.push({ socket, onOpen })
    })

    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', onPointerDown, true)
      backHandle?.remove()
      removeAppState()
      removeOpenWatch()
      for (const { socket, onOpen } of boundOpenListeners) socket.removeEventListener('open', onOpen)
      boundOpenListeners.length = 0
      // Deliberately no `setSuspended(false)` here — see the mount comment. The
      // next mount clears the flag, and until then the gate stays closed while the
      // app is hidden.
      void kbShow.then((h) => h?.remove())
      void kbHide.then((h) => h?.remove())
      document.documentElement.removeAttribute('data-drawer-open')
    }
  }, [])

  // No UI — this component exists only for the side effects wired up above.
  return null
}
