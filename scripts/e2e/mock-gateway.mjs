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

const MOCK_REPLY = 'mock-model-reply'

function sessionRow(session, now) {
  return {
    id: session.id,
    title: session.title,
    preview: session.messages.at(-1)?.content ?? null,
    ended_at: null,
    input_tokens: 1,
    output_tokens: 1,
    is_active: false,
    last_active: now,
    message_count: session.messages.length,
    model: 'mock',
    source: 'desktop',
    started_at: now - 60_000,
    tool_call_count: 0,
    profile: session.profile || 'default',
    hidden: Boolean(session.hidden),
    unread: false,
  }
}

function snapshot(session) {
  return {
    session_id: session.id,
    stored_session_id: session.id,
    revision: session.revision,
    execution_generation: session.generation,
    running: false,
    messages: session.messages.map((message, index) => ({
      id: `${session.id}-${index}`,
      role: message.role,
      content: message.content,
    })),
    info: {
      title: session.title,
      // v0.22.5 warns "backend out of date" unless the snapshot speaks the
      // canonical protocol (desktop_protocol === hermes-gateway-v1). The toast
      // sits over the roster and blocks the next click.
      desktop_protocol: 'hermes-gateway-v1',
      desktop_contract: 8,
    },
    prompts: [],
    pending: [],
  }
}

/** In-memory gateway the harness can log into, list, resume, and chat with. */
export function createWorld() {
  const now = Date.now()
  const sessions = {
    'e2e-session-1': {
      id: 'e2e-session-1',
      title: 'E2E Session',
      profile: 'default',
      hidden: false,
      revision: 1,
      generation: 1,
      messages: [
        { role: 'user', content: 'Earlier note' },
        { role: 'assistant', content: 'Noted.' },
      ],
    },
    'bot-chat-1': {
      id: 'bot-chat-1',
      title: 'Bot Chat',
      profile: 'researcher',
      hidden: true,
      revision: 1,
      generation: 1,
      messages: [{ role: 'assistant', content: 'Bot Chat ready' }],
    },
  }
  const profiles = [
    {
      name: 'researcher',
      display_name: 'Researcher',
      title: 'Research',
      description: 'E2E bot',
      canonical_session: { id: 'bot-chat-1', resolved_id: 'bot-chat-1', title: 'Bot Chat' },
      ui_meta: { 'hermes-bots': { title: 'Researcher' } },
    },
  ]
  return {
    now,
    sessions,
    profiles,
    /** Set by prompt.submit; the socket loop emits the mock turn from it. */
    lastSubmit: null,
  }
}

/** A minimal set of results the renderer needs to reach the Sessions/Bots shell. */
export function defaultHandlers(world = createWorld()) {
  const listSessions = (params = {}) => {
    let rows = Object.values(world.sessions)
    if (typeof params.title === 'string') rows = rows.filter((session) => session.title === params.title)
    if (!params.include_hidden) rows = rows.filter((session) => !session.hidden)
    return { sessions: rows.map((session) => sessionRow(session, world.now)) }
  }

  return new Map(Object.entries({
    'gateway.ping': () => ({}),
    'client.capabilities': () => ({ server_requests: true, declines_not_shown: false }),
    'session.list': (params) => listSessions(params),
    'sessions.list': () => listSessions(),
    'session.resume': (params) => {
      const session = world.sessions[params?.session_id]
      return session ? snapshot(session) : { session_id: params?.session_id, messages: [], revision: 1, execution_generation: 0, prompts: [], pending: [] }
    },
    'session.create': (params) => {
      const id = `created-${Object.keys(world.sessions).length + 1}`
      world.sessions[id] = {
        id,
        title: typeof params?.title === 'string' ? params.title : 'New',
        profile: typeof params?.profile === 'string' ? params.profile : 'default',
        hidden: Boolean(params?.hidden),
        revision: 1,
        generation: 0,
        messages: [],
      }
      return snapshot(world.sessions[id])
    },
    'session.title': (params) => {
      const session = world.sessions[params?.session_id]
      if (session && typeof params?.title === 'string') session.title = params.title
      return { ok: true, session_id: params?.session_id, revision: session?.revision ?? 1 }
    },
    'session.mutate': (params) => ({
      ok: true,
      session_id: params?.session_id,
      revision: Number(params?.expected_revision || 1) + 1,
      operation: params?.operation,
    }),
    'prompt.submit': (params) => {
      world.lastSubmit = params ?? {}
      const session = world.sessions[params?.session_id]
      const text = typeof params?.text === 'string' ? params.text : ''
      if (session && text) session.messages.push({ role: 'user', content: text }, { role: 'assistant', content: MOCK_REPLY })
      return {
        admission_id: 'mock-admission',
        ref: { session_id: params?.session_id },
        status: 'accepted',
      }
    },
    'profiles.list': () => ({ profiles: world.profiles }),
    'profiles.create': (params) => {
      const name = typeof params?.name === 'string' && params.name ? params.name : 'new-bot'
      world.profiles.push({
        name,
        display_name: name,
        title: name,
        description: typeof params?.description === 'string' ? params.description : '',
        canonical_session: null,
        ui_meta: { 'hermes-bots': {} },
      })
      return { ok: true, name }
    },
    'session.events.since': () => ({ events: [] }),
    // v0.22.5 blocks the shell with the provider setup overlay unless the
    // runtime check says a provider is already configured. This mock has no
    // model key; `ok: true` only means "do not cover the UI".
    'setup.status': () => ({ provider_configured: true }),
    'setup.runtime_check': () => ({ ok: true, provider: 'custom' }),
    'free_tier.status': () => ({ has_guest: false, notice_pending: false }),
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

export { MOCK_REPLY }

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

  const world = createWorld()
  const handlers = defaultHandlers(world)
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
      if (url.pathname === '/api/profiles') return send(200, { profiles: world.profiles })
      const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
      if (messagesMatch) {
        const session = world.sessions[decodeURIComponent(messagesMatch[1])]
        const messages = (session?.messages ?? []).map((message, index) => ({
          id: index + 1,
          role: message.role,
          content: message.content,
          timestamp: index + 1,
        }))
        // No pagination object: a page that carries pagination without an
        // honoured-order echo is discarded as "not the tail" and the transcript
        // stays empty. The array is the whole history.
        return send(200, { session_id: messagesMatch[1], messages })
      }
      if (url.pathname === '/api/profiles/sessions' || url.pathname === '/api/profiles/sessions/sidebar') {
        const visible = Object.values(world.sessions).filter((session) => !session.hidden).map((session) => sessionRow(session, world.now))
        if (url.pathname.endsWith('/sidebar')) {
          return send(200, { recents: { sessions: visible }, cron: { sessions: [] }, messaging: { sessions: [] } })
        }
        return send(200, { sessions: visible, offset: 0 })
      }
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
      if (frame.method === 'prompt.submit' && world.lastSubmit?.session_id) {
        const sessionId = world.lastSubmit.session_id
        world.lastSubmit = null
        for (const params of [
          { type: 'message.start', session_id: sessionId },
          { type: 'message.delta', session_id: sessionId, payload: { text: MOCK_REPLY } },
          { type: 'message.complete', session_id: sessionId, payload: { text: MOCK_REPLY } },
          { type: 'session.info', session_id: sessionId, payload: { running: false, revision: 2, execution_generation: 2 } },
        ]) {
          socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params }))
        }
      }
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
