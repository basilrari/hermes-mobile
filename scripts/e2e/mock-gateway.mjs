/**
 * mock-gateway.mjs — a tiny HTTPS + WSS Hermes gateway for the e2e harness.
 *
 * It exists so the harness can run on any box (and in CI) with no secret and no
 * private network: the real target is pavillion-claw, but rule 2 keeps its
 * password off cloud machines, so the default run uses this stand-in.
 *
 * Auth mode is **token** on purpose. A browser cannot read `Set-Cookie` (the
 * bridge's cookie capture is native-only by design, see cookie-jar.ts), so the
 * password/cookie login path cannot be exercised in a browser harness; token
 * mode can. Password login is Basil's tablet checklist.
 *
 * Unknown JSON-RPC methods are answered `{}` and logged, so the renderer's boot
 * requirements are visible from `--log` / the harness output.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'

const ALLOW_HEADERS = 'content-type, x-hermes-session-token, authorization'

/** A minimal set of results the renderer needs to reach the Sessions/Bots shell. */
export function defaultHandlers() {
  const now = Date.now()
  return new Map(Object.entries({
    'gateway.ping': () => ({}),
    'client.capabilities': () => ({ server_requests: true, declines_not_shown: false }),
    'session.list': () => ({
      sessions: [
        {
          id: 'e2e-session-1',
          title: 'E2E Session',
          created_at: now - 60_000,
          updated_at: now,
          message_count: 1,
          last_read_at: now,
          running: false,
        },
      ],
    }),
    'sessions.list': () => ({
      sessions: [
        {
          id: 'e2e-session-1',
          title: 'E2E Session',
          created_at: now - 60_000,
          updated_at: now,
          message_count: 1,
          last_read_at: now,
          running: false,
        },
      ],
    }),
    'groups.capabilities': () => ({
      driver: false,
      protocol_version: 1,
      features: [],
      methods: [],
      room_link: null,
      max_log_limit: 500,
    }),
    'groups.list': () => ({ rooms: [] }),
    // First-run onboarding is the backend's call (`onboarding.state` → {run,
    // eligible}); with neither, the renderer boots straight into the shell
    // instead of covering it with the setup flow.
    'onboarding.state': () => ({ run: false, eligible: false }),
  }))
}

/**
 * Start the mock. Resolves to a handle: { url, token, port, close, seen() }.
 */
export async function startMockGateway({ token = 'e2e-token', logPath = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-e2e-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
    { stdio: 'ignore' },
  )

  const handlers = defaultHandlers()
  const seen = []
  const log = (line) => {
    seen.push(line)
    if (logPath) fs.appendFileSync(logPath, `${line}\n`)
  }

  const cors = (origin) => ({
    'access-control-allow-origin': origin || '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': ALLOW_HEADERS,
    vary: 'Origin',
  })

  const server = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    (req, res) => {
      const origin = req.headers.origin
      const url = new URL(req.url ?? '/', 'https://localhost')
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json', ...cors(origin) })
        res.end(JSON.stringify(body))
      }
      log(`${req.method} ${url.pathname}`)

      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors(origin))
        return res.end()
      }
      // Token gateway: reachable, no login required, but a token is still asked for.
      if (url.pathname === '/api/status') {
        return send(200, { auth_required: false, version: 'e2e-mock' })
      }
      if (url.pathname === '/api/auth/providers') return send(200, { providers: [] })
      return send(404, { error: 'not_found', path: url.pathname })
    },
  )

  const wss = new WebSocketServer({ server, path: '/api/ws' })
  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/', 'https://localhost')
    if (url.searchParams.get('token') !== token) {
      socket.close(4401, 'bad token')
      return
    }
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', heartbeat: true } }))
    socket.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!frame || typeof frame.method !== 'string') return
      log(`RPC ${frame.method}`)
      if (frame.id === undefined) return
      const handler = handlers.get(frame.method)
      let result = {}
      try {
        result = handler ? handler(frame.params ?? {}) : {}
      } catch (error) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: String(error) } }))
        return
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    url: `https://localhost:${port}`,
    token,
    port,
    seen: () => [...seen],
    /** Register/extend an RPC handler (used while the renderer's needs are mapped). */
    on: (method, handler) => handlers.set(method, handler),
    close: async () => {
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
