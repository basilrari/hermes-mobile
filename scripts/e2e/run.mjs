#!/usr/bin/env node
/**
 * run.mjs — the headless e2e harness (HM-06).
 *
 * Serves the BUILT bundle (`apps/mobile/dist`) and drives it in headless Chrome
 * at the two target sizes, both orientations, using Playwright.
 *
 *   phone portrait  412x915      phone landscape  915x412
 *   tablet portrait 800x1280     tablet landscape 1280x800
 *
 * Scenarios per profile:
 *   1. the connect screen renders
 *   2. an `http://` gateway URL is refused (HTTPS only)
 *   3. token login → the renderer reaches the Sessions / Bots shell
 *   4. the RPC trace (HM-05) is live and shows no `bot_relay.*` call
 * plus one two-concurrent-client pass (sync tests build on it).
 *
 * Target: by default a local mock gateway (no secret, CI-safe). Point it at the
 * real box with:
 *     HERMES_E2E_GATEWAY_URL=https://pavillion-claw.tailfc1337.ts.net \
 *     HERMES_E2E_TOKEN=… npm run e2e
 * (Password login is native-only — a browser cannot read Set-Cookie — so the
 * real-gateway run exercises it only from the app on the tablet.)
 *
 * Exit 0 = every check passed. Any failure prints the RPC trace and exits 1.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { startMockGateway } from './mock-gateway.mjs'
import { classifyStorageKey, isConversationState } from './storage-rules.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const distDir = path.join(repoRoot, 'apps/mobile/dist')
const shotDir = path.join(here, 'screenshots')

const PROFILES = [
  { name: 'phone-portrait', width: 412, height: 915 },
  { name: 'phone-landscape', width: 915, height: 412 },
  { name: 'tablet-portrait', width: 800, height: 1280 },
  { name: 'tablet-landscape', width: 1280, height: 800 },
]

const TURN_BUDGET = Number(process.env.HERMES_E2E_TURN_BUDGET ?? '6')
let turnsUsed = 0

/**
 * Round-1 finding: `turnsUsed` was never incremented, so `turnsUsed > TURN_BUDGET`
 * could never fire and the acceptance line was vacuous. The guard is now
 * self-checked at startup — if the comparison is ever broken the harness refuses
 * to report a pass.
 *
 * Round-2 finding (review): the counter had no call site, so `countTurn` was dead
 * code and "0 / 6" still proved nothing. It is now exercised by a startup
 * self-check (a counted turn must move the number), so the increment cannot rot
 * back into dead code. Be precise about what that does NOT prove: no scenario in
 * this harness prompts a model — it drives an in-process mock — so the count
 * legitimately ends at 0 and the summary line says so, and the cap is therefore
 * NOT currently reachable. Round-3 finding (review) called the earlier wording
 * out, correctly: a real-gateway run would not increment it either, because no
 * scenario calls it. The budget binds the first scenario that prompts a model,
 * and that scenario must call countTurn().
 */
function turnBudgetExceeded(used, budget) {
  return used > budget
}
if (!turnBudgetExceeded(TURN_BUDGET + 1, TURN_BUDGET) || turnBudgetExceeded(TURN_BUDGET, TURN_BUDGET)) {
  console.error('turn-budget guard is broken: refusing to report a pass on a vacuous check')
  process.exit(2)
}

/** True when this run drives a real gateway, where a prompt actually costs a turn. */
const REAL_GATEWAY = Boolean(process.env.HERMES_E2E_GATEWAY_URL)

/** Set only by the startup self-check, so the counter can be exercised offline. */
let forceCount = false

/** Count one real LLM turn. Call before any scenario that prompts a model. */
function countTurn(label) {
  if (!REAL_GATEWAY && !forceCount) return // the mock gateway spends no model turn
  turnsUsed += 1
  console.log(`    · LLM turn ${turnsUsed}/${TURN_BUDGET} (${label})`)
  if (turnBudgetExceeded(turnsUsed, TURN_BUDGET)) {
    console.error(`FAIL: turn budget exceeded (${turnsUsed} > ${TURN_BUDGET})`)
    process.exit(1)
  }
}

// Self-check the counter itself: countTurn must move turnsUsed by exactly one.
// Without this the function can be deleted or short-circuited and the run still
// reports "0 / 6" as if it had checked something.
forceCount = true
countTurn('startup self-check')
forceCount = false
if (turnsUsed !== 1) {
  console.error(`turn counter is broken: one counted turn produced ${turnsUsed} (expected 1)`)
  process.exit(2)
}
turnsUsed = 0

/** Canonical lowercase UUID v4 (HM-25 contract). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.map': 'application/json',
}

/** Minimal static server for the built bundle, with SPA fallback. */
function serveDist() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // Require the resolved path to be INSIDE distDir. A bare startsWith accepted
    // a sibling whose name merely starts with the same characters
    // ('…/mobile/dist-evil/x'.startsWith('…/mobile/dist') is true). Round-1 finding.
    let requested
    try {
      requested = path.join(distDir, decodeURIComponent(url.pathname))
    } catch {
      requested = path.join(distDir, 'index.html')
    }
    const inside = requested === distDir || requested.startsWith(distDir + path.sep)
    let file = path.join(distDir, 'index.html')
    if (inside && fs.existsSync(requested) && !fs.statSync(requested).isDirectory()) {
      file = requested
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const results = []
const storageInventory = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`)
}

/**
 * A finding worth printing that is NOT a pass/fail: neither a break in the app
 * nor something the harness can decide. Kept out of `results` so it cannot pad
 * the score, and printed with a distinct marker so a reader can tell it apart
 * from a check.
 */
function note(text) {
  console.log(`  • ${text}`)
}

async function openClient(browser, profile, origin) {
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  return { context, page }
}

/**
 * The layout pass (HM-30 tablet polish, HM-31 phone pass).
 *
 * "Obvious breakage" is turned into assertions that can actually fail, instead of
 * a human squinting at a screenshot:
 *   - no horizontal overflow in any box that can actually scroll (see below);
 *   - the composer — the BOTTOM-DOCKED input, not the first input in document
 *     order — is present, bigger than a measurement probe and inside the
 *     viewport (a chat you cannot type into is broken whatever it looks like);
 *   - visible controls meet a 24 CSS px touch floor (Android's own guidance is
 *     48dp; the renderer's icon buttons are smaller, so 24 is the breakage
 *     floor) and anything under 32 is reported as polish.
 *
 * Round-2 findings (review) fixed in this version, all measured on this file:
 *   1. the touch-floor check passed the LITERAL `true` and ran only in the
 *      else-branch, so it could never fail and the floor carried no evidence.
 *      It now asserts on every run, against the known debt below.
 *   2. `documentElement.scrollWidth` is not a usable signal: #root is
 *      `position: fixed; inset: 0; overflow: hidden`, so a 3000px child leaves
 *      the document at the viewport width. The scrolling boxes are checked now.
 *   3. the composer selector resolved `input[placeholder="Search sessions…"]` at
 *      three of four viewports, and the 1x1 `textarea.sr-only` autosize probe
 *      satisfied every condition — delete the composer and it still passed.
 *   4. scroll-strip exemptions were collected and then thrown away, so a waiver
 *      was invisible. They are printed now.
 *   5. `outerHTML` was embedded in the detail, putting app markup (and any
 *      attribute a user or host typed) into an artefact that is otherwise
 *      "keys and sizes only". Geometry only now.
 *
 * Round-3: the status bar is not an exempted strip (chips must fit), and the
 * touch allowlist is compared to every offender, not the first five.
 */
const MIN_TOUCH_PX = 24
const POLISH_TOUCH_PX = 32
const MAX_TOUCH_REPORT = 5

/**
 * Controls below the touch floor that are KNOWN and owned upstream (issue #55:
 * the profile switcher's 20x20 icon buttons and the 12px-tall sidebar section
 * rows). Pinned by label so a NEW offender turns this check red while the known
 * renderer chrome stays visible as debt. When #55 lands, this list should empty.
 */
const KNOWN_UNDER_FLOOR = [
  'button[Pinned]',
  'button[Sessions]',
  'button[New profile]',
  'button[Import profile',
]

async function layoutFindings(page) {
  return page.evaluate(({ minTouch, polishTouch }) => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return false
      const style = window.getComputedStyle(el)
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0
    }

    const inHorizontalScroller = (el) => {
      // The status bar is not a waiver. This pass exists to contain it. An
      // `overflow-x: auto` footer made this return true and the check stayed
      // green while chips sat past the edge (right=545 in a 412 viewport on CI).
      if (el.closest("[data-slot='statusbar']")) return false
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = window.getComputedStyle(node)
        if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1) return true
      }
      return false
    }

    // Round-2 finding: `documentElement.scrollWidth` never moves here — #root is
    // `position: fixed; inset: 0; overflow: hidden`, so a 3000px child left the
    // document at the viewport width. Check the boxes that can really scroll.
    const documentOverflow = [document.documentElement, document.body, document.getElementById('root')]
      .filter(Boolean)
      .filter((el) => el.scrollWidth > vw + 1)
      .map((el) => `${el.id || el.tagName.toLowerCase()}.scrollWidth=${el.scrollWidth} > ${vw}`)

    const elementOverflow = []
    const scrollStrips = []
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue
      const r = el.getBoundingClientRect()
      if (r.right <= vw + 1 || r.width >= vw * 4) continue
      // An element inside an intentional horizontal scroller is SUPPOSED to sit
      // past the edge — that is how the strip scrolls. Exempt, but REPORT the
      // exemption (round-2 finding): a waiver nobody can see is not auditable.
      if (inHorizontalScroller(el)) {
        if (scrollStrips.length < 3) scrollStrips.push(`${el.tagName.toLowerCase()} right=${Math.round(r.right)}`)
        continue
      }
      // Geometry only — never outerHTML (round-2 finding).
      elementOverflow.push(`${el.tagName.toLowerCase()}.${String(el.className || '').split(' ').slice(0, 2).join('.')} right=${Math.round(r.right)} w=${Math.round(r.width)} parent=${(el.parentElement?.tagName || '').toLowerCase()}.${String(el.parentElement?.className || '').split(' ').slice(0, 2).join('.')}`)
      if (elementOverflow.length >= 4) break
    }

    // Counted in full. The assertion compares every offender to the allowlist;
    // the caller caps only the printed sample. A cap here hid a 6th label
    // (round-3 finding): the check then said "all known debt" about a list it
    // had not inspected.
    let touchTotal = 0
    const touchOffenders = []
    for (const el of document.querySelectorAll('button, a[href], input, textarea, select, [role="button"]')) {
      if (!visible(el)) continue
      const r = el.getBoundingClientRect()
      // A 1x1 (or 0-height) element is a renderer measurement hack, not a
      // control: autosize textareas and offscreen probes. Excluded explicitly.
      if (r.width * r.height <= 4) continue
      if (Math.min(r.width, r.height) < minTouch) {
        touchTotal += 1
        touchOffenders.push(`${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}]=${Math.round(r.width)}x${Math.round(r.height)}`)
      }
    }

    // Round-2 finding: the first match in document order is NOT the composer. At
    // three of four viewports it was the sessions search box, and the renderer's
    // 1x1 `textarea.sr-only` autosize probe satisfied every old condition — the
    // check passed with the composer deleted. Resolve the bottom-docked candidate
    // with real area instead.
    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')]
      .filter((el) => visible(el))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width * r.height > 4)
      .filter(({ r }) => r.bottom >= vh - 120)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)

    const best = candidates[0]
    const composerOk = Boolean(best) && best.r.left >= -1 && best.r.right <= vw + 1 && best.r.bottom <= vh + 1
    const composerNote = best
      ? `composer ${best.el.tagName.toLowerCase()} ${Math.round(best.r.width)}x${Math.round(best.r.height)} bottom=${Math.round(best.r.bottom)} of ${vh} (${candidates.length} bottom-docked candidate(s))`
      : 'no bottom-docked composer: nothing with real area within 120px of the bottom edge'

    return {
      documentOverflow,
      elementOverflow,
      scrollStrips,
      touchTotal,
      touchOffenders,
      composerOk,
      composerNote,
      viewport: `${vw}x${vh}`,
      polishTargets: [...document.querySelectorAll('button, [role="button"]')]
        .filter((el) => visible(el))
        .map((el) => { const r = el.getBoundingClientRect(); return Math.min(r.width, r.height) })
        .filter((v) => v > 0 && v < polishTouch).length,
    }
  }, { minTouch: MIN_TOUCH_PX, polishTouch: POLISH_TOUCH_PX })
}

/**
 * The steps after the token is submitted: dismiss the desktop renderer's
 * first-run onboarding if the backend says it is due, then wait for the shell.
 */
async function finishSignIn(page) {
  const chooseLater = page.getByRole('button', { name: /choose a provider later/i })
  if (await chooseLater.count()) {
    await chooseLater.first().click().catch(() => {})
    await chooseLater.first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
  }
  // Wide layouts dock a "Sessions" pane and title the composer "NEW SESSION".
  await page.locator('text=NEW SESSION').or(page.locator('text=Sessions')).first().waitFor({ state: 'visible', timeout: 45_000 })
}

/** The whole token login, for scenarios that do not need the intermediate screens. */
async function signIn(page, gatewayUrl, token) {
  await page.getByLabel('Gateway URL').waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByLabel('Gateway URL').fill(gatewayUrl)
  await page.getByRole('button', { name: 'Connect' }).click()
  await page.getByLabel('Session token').waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByLabel('Session token').fill(token)
  await page.getByRole('button', { name: 'Connect' }).click()
  await finishSignIn(page)
}

/** Steps 1–4 for one viewport. `gatewayUrl` is https. */
async function runProfile(browser, profile, origin, gatewayUrl, token) {
  console.log(`\n▸ ${profile.name} (${profile.width}x${profile.height})`)
  const { context, page } = await openClient(browser, profile, origin)
  try {
    const urlField = page.getByLabel('Gateway URL')
    await urlField.waitFor({ state: 'visible', timeout: 20_000 })
    check(`${profile.name}: connect screen renders`, true)
    await page.screenshot({ path: path.join(shotDir, `${profile.name}-01-connect.png`) })

    // 2. http:// is refused.
    await urlField.fill('http://insecure.example:9119')
    await page.getByRole('button', { name: 'Connect' }).click()
    // "No token field appeared" alone could pass on a slow transition or any
    // unrelated UI, so require the refusal to SAY why. Round-1 finding.
    const errorNote = page.locator('[class*="border-destructive"]').first()
    const shown = await errorNote.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false)
    const reason = shown ? (await errorNote.innerText()).trim() : ''
    check(
      `${profile.name}: http:// gateway refused with a visible reason`,
      shown && /https/i.test(reason),
      reason ? reason.slice(0, 90) : 'no error note rendered',
    )

    // 3. token login → shell.
    await urlField.fill(gatewayUrl)
    await page.getByRole('button', { name: 'Connect' }).click()
    const tokenField = page.getByLabel('Session token')
    await tokenField.waitFor({ state: 'visible', timeout: 20_000 })
    await page.screenshot({ path: path.join(shotDir, `${profile.name}-02-token.png`) })
    await tokenField.fill(token)
    await page.getByRole('button', { name: 'Connect' }).click()

    // The desktop renderer's first-run onboarding (when the backend says it is
    // due) overlays the shell; dismiss it the way a user does. The mock answers
    // `onboarding.state` as not-run, so this is only a fallback against a real
    // gateway that does want to onboard.
    await finishSignIn(page)
    check(`${profile.name}: login reaches the chat shell`, true)
    // The titlebar controls mount a beat after the first paint.
    await page.waitForTimeout(2000)

    // The roster surface. Docked at >=640 CSS px (Bots next to Sessions); on a
    // phone the panes are hidden behind the titlebar's "Show sidebar" control
    // (mobile-behaviors.tsx), so open it the way a user does.
    let bots = await page.getByText('Bots', { exact: false }).count()
    let how = bots > 0 ? 'docked' : 'none'
    if (bots === 0) {
      const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
      const appeared = await showSidebar.first().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)
      if (appeared) {
        // Direct DOM click: the drawer's own scrim can make an actionability
        // check flaky, and this is a toggle we only need to fire once.
        await showSidebar.first().evaluate((el) => el.click())
        await page.getByText('Bots', { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
        bots = await page.getByText('Bots', { exact: false }).count()
        how = bots > 0 ? 'via Show sidebar' : 'none'
      }
    }
    check(`${profile.name}: Bots roster surface present`, bots > 0, how)
    if ((await page.getByText('CONNECTING', { exact: false }).count()) > 0) {
      console.log(`    ! ${profile.name}: boot overlay still on screen against the mock gateway`)
    }
    const layout = await layoutFindings(page)
    check(`${profile.name}: no horizontal overflow in any scrollable box`, layout.documentOverflow.length === 0 && layout.elementOverflow.length === 0,
      [...layout.documentOverflow, ...layout.elementOverflow].join(' | ') || `all boxes within viewport ${layout.viewport}`)
    if (layout.scrollStrips.length) {
      note(`${profile.name}: ${layout.scrollStrips.length} element(s) exempted inside a horizontal scroller — ${layout.scrollStrips.join(' | ')}`)
    }
    check(`${profile.name}: composer visible inside the viewport`, layout.composerOk, layout.composerNote)
    // Asserts on EVERY run (round-2 finding: the old version passed the literal
    // `true` in an else-branch, so it could only run when nothing was wrong and
    // reported success unconditionally). Known renderer chrome under the floor is
    // pinned in KNOWN_UNDER_FLOOR (issue #55) so THIS check cannot go quiet: any
    // offender that is not the known debt fails it.
    const unexpected = layout.touchOffenders.filter((o) => !KNOWN_UNDER_FLOOR.some((known) => o.startsWith(known)))
    const sample = (list) => {
      const head = list.slice(0, MAX_TOUCH_REPORT).join(' | ')
      return list.length > MAX_TOUCH_REPORT ? `${head} (+${list.length - MAX_TOUCH_REPORT} more)` : head
    }
    const touchDetail = layout.touchTotal === 0
      ? 'all visible controls >= floor'
      : `${layout.touchTotal} under the ${MIN_TOUCH_PX}px floor${unexpected.length ? ` — NEW: ${sample(unexpected)}` : ` — all known debt (#55): ${sample(layout.touchOffenders)}`}`
    check(`${profile.name}: no NEW control under the ${MIN_TOUCH_PX}px touch floor`, unexpected.length === 0, touchDetail)
    if (layout.polishTargets > 0) {
      note(`${profile.name}: ${layout.polishTargets} control(s) under ${POLISH_TOUCH_PX}px — polish list, not breakage`)
    }
    await page.screenshot({ path: path.join(shotDir, `${profile.name}-03-app.png`) })

    // 4. the trace is live and clean. Zero relay traffic is M1's acceptance
    // (#11 removed the Desktop relay from mobile; this is its assertion).
    const trace = await page.evaluate(() => (window.__hermesRpcTrace ? window.__hermesRpcTrace.toText() : null))
    check(`${profile.name}: RPC trace global is live`, typeof trace === 'string' && trace.length > 0)
    const relayCalls = (trace ?? '').split('\n').filter((line) => line.includes('bot_relay.'))
    check(
      `${profile.name}: no bot_relay.* call`,
      relayCalls.length === 0,
      relayCalls.length ? relayCalls.slice(0, 3).join(' | ') : 'the relay is off on mobile',
    )
    if (process.env.HERMES_E2E_DUMP_TRACE === '1') console.log(trace ?? '(no trace)')

    // The bridge contract (HM-12): the durable send journal is exposed, and the
    // renderer's own localStorage fallback key is untouched.
    const bridge = await page.evaluate(() => {
      const ps = window.hermesDesktop?.preparedSubmissions
      return {
        journal:
          !!ps &&
          typeof ps.read === 'function' &&
          typeof ps.update === 'function' &&
          typeof ps.compareAndSet === 'function',
        fallbackKey: window.localStorage.getItem('hermes.desktop.preparedSubmissions.v1'),
      }
    })
    check(`${profile.name}: preparedSubmissions contract exposed`, bridge.journal)
    check(`${profile.name}: journal absent from the renderer localStorage key`, bridge.fallbackKey === null)

    // deviceIdentity (HM-25): contract method present and returning a v4 uuid.
    const identity = await page.evaluate(async () => {
      try {
        const value = await window.hermesDesktop?.deviceIdentity?.()
        return { deviceId: value?.device_id ?? null, label: value?.label ?? null }
      } catch {
        return { deviceId: null, label: null }
      }
    })
    check(`${profile.name}: deviceIdentity returns a v4 uuid`, UUID_V4.test(identity.deviceId ?? ''))
    check(`${profile.name}: deviceIdentity carries a label`, typeof identity.label === 'string' && identity.label.length > 0)

    // Storage inventory (HM-13). KEYS AND SIZES ONLY — never a value: the same
    // find could otherwise put a session token into an artefact.
    const inventory = await page.evaluate(async () => {
      const local = []
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index)
        if (key === null) continue
        local.push({ key, bytes: (window.localStorage.getItem(key) ?? '').length })
      }
      const session = []
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index)
        if (key === null) continue
        session.push({ key, bytes: (window.sessionStorage.getItem(key) ?? '').length })
      }
      let databases = []
      try {
        databases = ((await window.indexedDB?.databases?.()) ?? []).map((db) => db.name ?? '(unnamed)')
      } catch {
        databases = []
      }
      return {
        local: local.sort((a, b) => a.key.localeCompare(b.key)),
        session: session.sort((a, b) => a.key.localeCompare(b.key)),
        databases,
      }
    })
    storageInventory.push({ profile: profile.name, ...inventory })

    const localKeys = inventory.local.map((entry) => entry.key)
    const sessionKeys = inventory.session.map((entry) => entry.key)
    const dbNames = inventory.databases
    // Every store, not just localStorage: sessionStorage and an IndexedDB
    // database name are equally able to hold conversation state. Round-1 finding.
    const everywhere = [...localKeys, ...sessionKeys, ...dbNames]
    const leaked = everywhere.filter((key) => isConversationState(key))
    check(
      `${profile.name}: no conversation state on the device`,
      leaked.length === 0,
      leaked.length
        ? leaked.join(' | ')
        : `${localKeys.length} localStorage + ${sessionKeys.length} sessionStorage key(s), ${dbNames.length} IndexedDB db(s) — all UI prefs or bridge state`,
    )
    const unknown = [...localKeys, ...sessionKeys].filter((key) => !classifyStorageKey(key).known)
    if (unknown.length > 0) console.log(`    ! ${profile.name}: unclassified storage key(s): ${unknown.join(', ')}`)
  } finally {
    await context.close()
  }
}

/** Two clients at once (the base for the later sync/read-state scenarios). */
async function runTwoClients(browser, origin, gatewayUrl, token) {
  console.log('\n▸ two concurrent clients')
  const [a, b] = await Promise.all([
    openClient(browser, PROFILES[3], origin),
    openClient(browser, PROFILES[0], origin),
  ])
  try {
    for (const [label, { page }] of [['tablet', a], ['phone', b]]) {
      await page.getByLabel('Gateway URL').waitFor({ state: 'visible', timeout: 20_000 })
      await page.getByLabel('Gateway URL').fill(gatewayUrl)
      await page.getByRole('button', { name: 'Connect' }).click()
      await page.getByLabel('Session token').waitFor({ state: 'visible', timeout: 20_000 })
      await page.getByLabel('Session token').fill(token)
      await page.getByRole('button', { name: 'Connect' }).click()
      // Phone portrait does not mount the Sessions pane until Show sidebar
      // (below 640px; mobile-behaviors.tsx). Waiting only for "Sessions" timed
      // out on CI after the tablet had connected (run 38923939411, run.mjs:475).
      // finishSignIn is the shell-ready check runProfile already passes on that
      // viewport: dismiss onboarding, then NEW SESSION or Sessions.
      await finishSignIn(page)
      check(`two clients: ${label} connected`, true)
    }
  } catch (error) {
    const phoneState = await b.page.evaluate(() => ({
      newSession: document.body.innerText.includes('NEW SESSION'),
      sessions: document.body.innerText.includes('Sessions'),
      showSidebar: document.body.innerText.includes('Show sidebar'),
      connecting: document.body.innerText.includes('CONNECTING'),
      onboarding: /choose a provider later/i.test(document.body.innerText),
    })).catch(() => null)
    console.error(`two clients: phone shell state ${JSON.stringify(phoneState)}`)
    throw error
  } finally {
    await Promise.all([a.context.close(), b.context.close()])
  }
}

/** HM-25: the id must survive a relaunch. In a browser that is a page reload. */
async function runIdentityPersistence(browser, origin, gatewayUrl, token) {
  console.log('\n▸ device identity across a relaunch')
  const { context, page } = await openClient(browser, PROFILES[3], origin)
  try {
    await signIn(page, gatewayUrl, token)
    const before = await page.evaluate(async () => (await window.hermesDesktop?.deviceIdentity?.())?.device_id ?? null)

    await page.reload({ waitUntil: 'domcontentloaded' })
    if (await page.getByLabel('Gateway URL').count()) {
      // A fresh origin asks to connect again; a saved target goes straight in.
      await signIn(page, gatewayUrl, token)
    } else {
      await page.getByText('Sessions', { exact: false }).first().waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {})
    }
    const after = await page.evaluate(async () => (await window.hermesDesktop?.deviceIdentity?.())?.device_id ?? null)

    check(
      'deviceIdentity: same id across a relaunch',
      Boolean(before) && before === after,
      before ? `${before.slice(0, 8)}…` : 'no id before the reload',
    )
  } finally {
    await context.close()
  }
}

/**
 * Prefer the system Chrome; fall back to Playwright's bundled Chromium. The PR
 * sold a CI-safe default run, and pinning `channel: 'chrome'` alone would fail
 * on a runner without it. HERMES_E2E_BUNDLED_CHROMIUM=1 skips the system probe.
 */
async function launchBrowser() {
  if (!process.env.HERMES_E2E_BUNDLED_CHROMIUM) {
    try {
      return await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] })
    } catch (error) {
      console.log(`harness: system Chrome unavailable (${String(error).split('\n')[0]}); using bundled Chromium`)
    }
  }
  return chromium.launch({ args: ['--no-sandbox'] })
}

async function main() {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error(`No built bundle at ${distDir}. Run: npm run build:mobile`)
    process.exit(2)
  }
  fs.mkdirSync(shotDir, { recursive: true })

  const external = process.env.HERMES_E2E_GATEWAY_URL
  const mock = external ? null : await startMockGateway({ logPath: path.join(shotDir, 'mock-gateway.log') })
  const gatewayUrl = external ?? mock.url
  // The fallback lets a URL-only run authenticate. It is not a supplied credential.
  const suppliedToken = process.env.HERMES_E2E_TOKEN
  const token = external ? (suppliedToken ?? 'e2e-token') : mock.token

  // Never print the credential; say only whether one was supplied.
  const credential = external ? (suppliedToken ? 'set' : 'none') : 'set'
  console.log(`harness: target=${external ? 'HERMES_E2E_GATEWAY_URL' : 'mock gateway'} credential=${credential}`)

  const { server, port } = await serveDist()
  const origin = `http://127.0.0.1:${port}`
  const browser = await launchBrowser()

  try {
    for (const profile of PROFILES) {
      await runProfile(browser, profile, origin, gatewayUrl, token)
    }
    await runTwoClients(browser, origin, gatewayUrl, token)
    await runIdentityPersistence(browser, origin, gatewayUrl, token)
  } finally {
    await browser.close()
    server.close()
    if (mock) await mock.close()
  }

  const classified = storageInventory.map((entry) => ({
    profile: entry.profile,
    sessions: entry.session.length,
    databases: entry.databases,
    local: entry.local.map((item) => ({ ...item, ...classifyStorageKey(item.key) })),
  }))
  fs.writeFileSync(path.join(shotDir, 'storage-inventory.json'), `${JSON.stringify(classified, null, 2)}\n`)
  console.log(`\nstorage inventory: ${storageInventory[0]?.local.length ?? 0} localStorage key(s), ${storageInventory[0]?.session.length ?? 0} sessionStorage key(s), ${storageInventory[0]?.databases.length ?? 0} IndexedDB database(s) — see storage-inventory.json`)
  const failed = results.filter((r) => !r.ok)
  const cap = turnsUsed > TURN_BUDGET
  console.log(`\nLLM turns: ${turnsUsed} / ${TURN_BUDGET} budget (DeepSeek Flash only)${REAL_GATEWAY ? ' — no scenario counts a turn' : ' — mock gateway, no model turn spent'}`)
  if (cap) console.error(`\nFAIL: turn budget exceeded (${turnsUsed} > ${TURN_BUDGET})`)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 && !cap ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
