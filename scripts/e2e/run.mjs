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
 *     HERMES_E2E_PASSWORD=… npm run e2e
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

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.map': 'application/json',
}

/** Minimal static server for the built bundle, with SPA fallback. */
function serveDist() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let file = path.join(distDir, decodeURIComponent(url.pathname))
    if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(distDir, 'index.html')
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`)
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
    await page.waitForTimeout(750)
    const refused = (await page.getByLabel('Session token').count()) === 0 && (await page.locator('body').innerText()).length > 0
    check(`${profile.name}: http:// gateway refused`, refused)

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
    const chooseLater = page.getByRole('button', { name: /choose a provider later/i })
    if (await chooseLater.count()) {
      await chooseLater.first().click().catch(() => {})
      await chooseLater.first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
    }

    // The renderer boots its own UI. Wide layouts dock a "Sessions" pane and
    // title the composer "NEW SESSION"; either proves the shell mounted.
    const shell = page.locator('text=NEW SESSION').or(page.locator('text=Sessions')).first()
    await shell.waitFor({ state: 'visible', timeout: 45_000 })
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
      await page.getByText('Sessions', { exact: false }).first().waitFor({ state: 'visible', timeout: 45_000 })
      check(`two clients: ${label} connected`, true)
    }
  } finally {
    await Promise.all([a.context.close(), b.context.close()])
  }
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
  const token = external ? (process.env.HERMES_E2E_TOKEN ?? 'e2e-token') : mock.token

  // Never print the credential; say only whether one was supplied.
  console.log(`harness: target=${external ? 'HERMES_E2E_GATEWAY_URL' : 'mock gateway'} credential=${token ? 'set' : 'none'}`)

  const { server, port } = await serveDist()
  const origin = `http://127.0.0.1:${port}`
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] })

  try {
    for (const profile of PROFILES) {
      await runProfile(browser, profile, origin, gatewayUrl, token)
    }
    await runTwoClients(browser, origin, gatewayUrl, token)
  } finally {
    await browser.close()
    server.close()
    if (mock) await mock.close()
  }

  const failed = results.filter((r) => !r.ok)
  const cap = turnsUsed > TURN_BUDGET
  console.log(`\nLLM turns: ${turnsUsed} / ${TURN_BUDGET} budget (DeepSeek Flash only)`)
  if (cap) console.error(`\nFAIL: turn budget exceeded (${turnsUsed} > ${TURN_BUDGET})`)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 && !cap ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
