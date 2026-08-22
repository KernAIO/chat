/**
 * The Kern realtime WebSocket gateway.
 *
 * One socket per browser tab carries every module's realtime traffic. Clients speak the protocol in
 * `@kernalo/contracts` (`ClientMessage` / `ServerMessage`): they authenticate with `hello`, subscribe to
 * channels, and receive entity changes, notifications, badges, typing and presence.
 *
 * Services never talk to sockets directly. They publish through `kernel.realtime`, which fans out over
 * NATS subjects (`kern.rt.ch.*`, `kern.rt.user.*`); every gateway replica forwards what its own sockets
 * subscribe to. Publishes made inside this process are delivered locally as well, without a round trip.
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  ANONYMOUS,
  type ClientMessage,
  channel as chan,
  type Principal,
  type ServerMessage,
} from '@kernalo/contracts'
import type { Kernel } from '@kernalo/kernel'
import { rtSubject } from '@kernalo/kernel'
import { StringCodec } from 'nats'
import { WebSocket, WebSocketServer } from 'ws'
import type { ChatEnv } from './env.js'

const sc = StringCodec()

interface Socket {
  id: string
  ws: WebSocket
  /** cookie header from the upgrade request, used when the client has no bearer token */
  cookie: string | null
  principal: Principal
  channels: Set<string>
  seq: number
  alive: boolean
  missedPings: number
  authenticated: boolean
  lastTyping: Map<string, number>
}

export interface Gateway {
  /** attach to the HTTP server's upgrade event */
  attach(server: Server): void
  /** deliver a message published inside this process (no NATS round trip) */
  deliverLocal(subject: string, msg: unknown): void
  stats(): { sockets: number; users: number; subscriptions: number }
  close(): Promise<void>
}

export interface GatewayOptions {
  kernel: Kernel
  env: ChatEnv
  path?: string
  /** resolves a session token into a principal (core service) */
  resolvePrincipal(token: string): Promise<Principal>
  /** resolves the cookies sent with the upgrade request into a principal */
  resolvePrincipalFromCookie(cookie: string): Promise<Principal>
  /** true when the user may subscribe to a chat channel */
  canJoinChannel(principal: Principal, workspaceId: string | null, channelId: string): Promise<boolean>
}

export function createGateway(opts: GatewayOptions): Gateway {
  const { kernel, env } = opts
  const path = opts.path ?? '/ws'
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  const sockets = new Map<string, Socket>()
  /** channel name → socket ids */
  const subscribers = new Map<string, Set<string>>()
  /** user id → socket ids */
  const byUser = new Map<string, Set<string>>()

  const send = (s: Socket, msg: ServerMessage | Record<string, unknown>) => {
    if (s.ws.readyState !== WebSocket.OPEN) return
    s.ws.send(JSON.stringify(msg))
  }
  const sendSeq = (s: Socket, msg: Record<string, unknown>) => send(s, { ...msg, seq: ++s.seq })

  const subscribe = (s: Socket, name: string) => {
    if (s.channels.has(name)) return
    s.channels.add(name)
    let set = subscribers.get(name)
    if (!set) subscribers.set(name, (set = new Set()))
    set.add(s.id)
  }
  const unsubscribe = (s: Socket, name: string) => {
    s.channels.delete(name)
    const set = subscribers.get(name)
    if (!set) return
    set.delete(s.id)
    if (!set.size) subscribers.delete(name)
  }

  /** fan a message out to every local socket subscribed to `name` */
  const toChannel = (name: string, msg: Record<string, unknown>, exceptSocket?: string) => {
    for (const id of subscribers.get(name) ?? []) {
      if (id === exceptSocket) continue
      const s = sockets.get(id)
      if (s) sendSeq(s, msg)
    }
  }
  const toUser = (userId: string, msg: Record<string, unknown>) => {
    for (const id of byUser.get(userId) ?? []) {
      const s = sockets.get(id)
      if (s) sendSeq(s, msg)
    }
  }

  // ---- NATS fan-in: forward what other replicas and services publish ----
  const natsSubs: Array<{ unsubscribe(): void }> = []
  if (kernel.nats) {
    const chSub = kernel.nats.subscribe('kern.rt.ch.*')
    const userSub = kernel.nats.subscribe('kern.rt.user.*')
    natsSubs.push(chSub, userSub)
    void (async () => {
      for await (const m of chSub) {
        const name = m.subject.slice('kern.rt.ch.'.length)
        toChannel(decodeChannel(name), safeParse(m.data))
      }
    })()
    void (async () => {
      for await (const m of userSub) {
        toUser(m.subject.slice('kern.rt.user.'.length), safeParse(m.data))
      }
    })()
  }

  const presenceKey = (userId: string) => `presence:${userId}`
  const setPresence = async (userId: string, status: string) => {
    await kernel.redis?.set(presenceKey(userId), status, 'EX', env.PRESENCE_TTL_SEC)
  }
  const clearPresence = async (userId: string) => {
    await kernel.redis?.del(presenceKey(userId))
  }
  /** announce presence to every workspace the user is a member of */
  const broadcastPresence = (p: Principal, status: string) => {
    if (!p.userId) return
    const msg = { t: 'presence', userId: p.userId, status, lastSeen: Date.now() }
    for (const m of p.memberships) toChannel(chan.workspace(m.workspaceId), msg)
  }

  async function authorize(s: Socket, name: string): Promise<boolean> {
    const p = s.principal
    if (name === chan.user(p.userId ?? '')) return true
    if (name.startsWith('ws:')) {
      const [, workspaceId] = name.split(':')
      if (!workspaceId) return false
      return p.instanceAdmin || p.memberships.some((m) => m.workspaceId === workspaceId)
    }
    if (name.startsWith('chat:')) {
      const channelId = name.slice('chat:'.length)
      const workspaceId = p.memberships[0]?.workspaceId ?? null
      return opts.canJoinChannel(p, workspaceId, channelId)
    }
    return false
  }

  async function onHello(s: Socket, msg: Extract<ClientMessage, { t: 'hello' }>) {
    // Browsers cannot read the HttpOnly session cookie, so a first-party client sends no token and
    // relies on the cookie the browser attaches to the upgrade request instead. API clients and
    // native apps present a bearer token in `hello`.
    const principal = await (msg.token
      ? opts.resolvePrincipal(msg.token)
      : s.cookie
        ? opts.resolvePrincipalFromCookie(s.cookie)
        : Promise.resolve(ANONYMOUS)
    ).catch(() => ANONYMOUS)
    if (principal.kind === 'anonymous' || !principal.userId) {
      send(s, { t: 'error', code: 'UNAUTHORIZED', message: 'Invalid or expired session' })
      s.ws.close(4401, 'unauthorized')
      return
    }
    s.principal = principal
    s.authenticated = true

    let users = byUser.get(principal.userId)
    if (!users) byUser.set(principal.userId, (users = new Set()))
    users.add(s.id)
    // keep a user's socket count bounded (a tab that never closes cleanly should not accumulate)
    if (users.size > env.MAX_SOCKETS_PER_USER) {
      const oldest = [...users][0]
      if (oldest && oldest !== s.id) sockets.get(oldest)?.ws.close(4000, 'too many connections')
    }

    subscribe(s, chan.user(principal.userId))
    for (const m of principal.memberships) subscribe(s, chan.workspace(m.workspaceId))

    send(s, { t: 'welcome', userId: principal.userId, serverTime: Date.now(), resumed: false })
    await setPresence(principal.userId, 'online')
    broadcastPresence(principal, 'online')
    kernel.log.debug({ userId: principal.userId, socket: s.id }, 'ws authenticated')
  }

  async function onMessage(s: Socket, raw: string) {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw)
    } catch {
      return send(s, { t: 'error', code: 'BAD_REQUEST', message: 'Malformed message' })
    }
    if (msg.t === 'hello') return onHello(s, msg)
    if (!s.authenticated) {
      send(s, { t: 'error', code: 'UNAUTHORIZED', message: 'Send hello first' })
      return s.ws.close(4401, 'unauthorized')
    }
    switch (msg.t) {
      case 'ping':
        return send(s, { t: 'pong' })
      case 'sub': {
        for (const name of msg.channels) {
          if (await authorize(s, name)) subscribe(s, name)
          else send(s, { t: 'error', code: 'FORBIDDEN', message: `Cannot subscribe to ${name}` })
        }
        return
      }
      case 'unsub':
        for (const name of msg.channels) unsubscribe(s, name)
        return
      case 'typing': {
        const name = chan.chat(msg.channelId)
        if (!s.channels.has(name)) return
        const now = Date.now()
        const last = s.lastTyping.get(msg.channelId) ?? 0
        if (now - last < env.TYPING_THROTTLE_MS) return
        s.lastTyping.set(msg.channelId, now)
        toChannel(
          name,
          {
            t: 'typing',
            channelId: msg.channelId,
            workspaceId: msg.workspaceId,
            userId: s.principal.userId,
            threadId: msg.threadId,
            at: now,
          },
          s.id, // never echo to the sender
        )
        return
      }
      case 'presence':
        if (!s.principal.userId) return
        await setPresence(s.principal.userId, msg.status)
        broadcastPresence(s.principal, msg.status)
        return
      case 'ack':
        return
    }
  }

  function onClose(s: Socket) {
    sockets.delete(s.id)
    for (const name of s.channels) {
      const set = subscribers.get(name)
      set?.delete(s.id)
      if (set && !set.size) subscribers.delete(name)
    }
    const userId = s.principal.userId
    if (!userId) return
    const users = byUser.get(userId)
    users?.delete(s.id)
    if (users && !users.size) {
      byUser.delete(userId)
      // Last socket on this replica: mark offline. Another replica may still hold a socket for the
      // user, in which case its presence heartbeat restores the key within PRESENCE_TTL_SEC.
      void clearPresence(userId)
      broadcastPresence(s.principal, 'offline')
    }
  }

  wss.on('connection', (ws: WebSocket, req?: IncomingMessage) => {
    const s: Socket = {
      id: randomUUID(),
      ws,
      cookie: req?.headers.cookie ?? null,
      principal: ANONYMOUS,
      channels: new Set(),
      seq: 0,
      alive: true,
      missedPings: 0,
      authenticated: false,
      lastTyping: new Map(),
    }
    sockets.set(s.id, s)
    const helloTimer = setTimeout(() => {
      if (!s.authenticated) {
        send(s, { t: 'error', code: 'UNAUTHORIZED', message: 'Timed out waiting for hello' })
        ws.close(4401, 'hello timeout')
      }
    }, env.WS_HELLO_TIMEOUT_MS)
    helloTimer.unref()

    ws.on('message', (data) => {
      void onMessage(s, data.toString()).catch((err) =>
        kernel.log.error({ err, socket: s.id }, 'ws message failed'),
      )
    })
    ws.on('pong', () => {
      s.alive = true
      s.missedPings = 0
      if (s.principal.userId) void setPresence(s.principal.userId, 'online')
    })
    ws.on('close', () => {
      clearTimeout(helloTimer)
      onClose(s)
    })
    ws.on('error', () => ws.close())
  })

  const heartbeat = setInterval(() => {
    for (const s of sockets.values()) {
      if (!s.alive && ++s.missedPings >= 2) {
        s.ws.terminate()
        continue
      }
      s.alive = false
      if (s.ws.readyState === WebSocket.OPEN) s.ws.ping()
    }
  }, env.WS_PING_INTERVAL_MS)
  heartbeat.unref()

  return {
    attach(server) {
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const { pathname } = new URL(req.url ?? '/', 'http://localhost')
        if (pathname !== path) return
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      })
      kernel.log.info({ path }, 'realtime gateway attached')
    },
    deliverLocal(subject, msg) {
      if (subject.startsWith('kern.rt.ch.')) {
        toChannel(decodeChannel(subject.slice('kern.rt.ch.'.length)), msg as Record<string, unknown>)
      } else if (subject.startsWith('kern.rt.user.')) {
        toUser(subject.slice('kern.rt.user.'.length), msg as Record<string, unknown>)
      }
    },
    stats: () => ({ sockets: sockets.size, users: byUser.size, subscriptions: subscribers.size }),
    async close() {
      clearInterval(heartbeat)
      for (const sub of natsSubs) sub.unsubscribe()
      for (const s of sockets.values()) s.ws.close(1001, 'server shutting down')
      await new Promise<void>((done) => wss.close(() => done()))
    },
  }
}

/** `kern.rt.ch.<name>` encodes `:` as `_` (see `rtSubject` in the kernel). */
function decodeChannel(subjectPart: string): string {
  for (const [prefix, restored] of [
    ['ws_', 'ws:'],
    ['chat_', 'chat:'],
    ['user_', 'user:'],
  ] as const) {
    if (subjectPart.startsWith(prefix)) return restored + subjectPart.slice(prefix.length).replace(/_/g, ':')
  }
  return subjectPart
}

function safeParse(data: Uint8Array): Record<string, unknown> {
  try {
    return JSON.parse(sc.decode(data))
  } catch {
    return {}
  }
}

export { rtSubject }
