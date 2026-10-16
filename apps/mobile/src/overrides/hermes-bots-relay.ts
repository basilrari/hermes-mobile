/**
 * overrides/hermes-bots-relay.ts — mobile override for the Desktop bot relay (HM-11).
 *
 * The upstream `plugins/hermes-bots/plugin.tsx` calls `startBotRelay()` when it
 * registers. The relay is Desktop-as-router: it owns a socket to every gateway
 * the Desktop knows and publishes each gateway the union roster of the agents on
 * its OTHER connections (`bot_relay.roster.sync`). On a phone there is exactly
 * one connection, so the relay publishes an EMPTY roster — and
 * `write_remote_roster` replaces the gateway's `roster.json` wholesale, so
 * opening the app could wipe the roster a Desktop had published entirely
 * (upstream #115161). The app has no second connection to relay to (cross-gateway
 * messaging is out of scope), so the relay is dead weight with a destructive edge.
 *
 * This module replaces the real relay FOR plugin.tsx ONLY, through the Vite
 * `resolveId` override in `relay-override.ts`. The desktop source is untouched
 * (mobile never forks the renderer). It is the first entry of the mobile override
 * mechanism that HM-16 formalises; removal condition: delete this override once
 * the upstream relay stops publishing an empty roster for a sole connection
 * (i.e. once #115161 is fixed upstream).
 *
 * Bot Mode itself does not use the relay — the roster comes from the gateway's
 * own RPC (`data.ts`), so disabling the relay leaves the Bots tab working.
 */

export function startBotRelay(): void {
  // Intentionally inert on mobile (see the module header).
}

export function stopBotRelay(): void {
  // Intentionally inert on mobile.
}
