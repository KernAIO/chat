/**
 * The Kern realtime WebSocket gateway.
 *
 * One socket per browser tab carries every module's realtime traffic. Clients speak the protocol in
 * `@kernhq/contracts` (`ClientMessage` / `ServerMessage`): they authenticate with `hello`, subscribe to
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
  type EventEnvelope,
  type Principal,
  type ServerMessage,
} from '@kernhq/contracts'
import type { Kernel } from '@kernhq/kernel'
import { rtSubject } from '@kernhq/kernel'
import { StringCodec } from 'nats'
import { WebSocket, WebSocketServer } from 'ws'
import type { ChatEnv } from './env.js'

const sc = StringCodec()

/** How many messages one subscription may hold while its re-authorisation is in flight. */
const MAX_HELD_MESSAGES = 256

/** One channel a socket is subscribed to, with the age of the answer that admitted it. */
interface Subscription {
  /** when `authorize` last said yes for this socket and this channel */
  checkedAt: number
  /** messages held while a re-authorisation is in flight; `null` when none is */
  pending: Array<Record<string, unknown>> | null
}

interface Socket {
  id: string
  ws: WebSocket
  /** cookie header from the upgrade request, used when the client has no bearer token */
  cookie: string | null
  principal: Principal
  channels: Map<string, Subscription>
  seq: number
  alive: boolean
  missedPings: number
  authenticated: boolean
  /** resolves once the `hello` in flight has been answered; messages that arrive meanwhile wait on it */
  authenticating: Promise<void> | null
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
    s.channels.set(name, { checkedAt: Date.now(), pending: null })
    let set = subscribers.get(name)
    if (!set) {
      set = new Set()
      subscribers.set(name, set)
    }
    set.add(s.id)
  }
  const unsubscribe = (s: Socket, name: string) => {
    s.channels.delete(name)
    const set = subscribers.get(name)
    if (!set) return
    set.delete(s.id)
    if (!set.size) subscribers.delete(name)
  }
  const socketsOf = (userId: string): Socket[] =>
    [...(byUser.get(userId) ?? [])].flatMap((id) => {
      const s = sockets.get(id)
      return s ? [s] : []
    })

  /** Drop a subscription the socket may no longer have, and tell the client why it went quiet. */
  const revoke = (s: Socket, name: string) => {
    if (!s.channels.has(name)) return
    unsubscribe(s, name)
    send(s, { t: 'error', code: 'FORBIDDEN', message: `Subscription to ${name} was revoked` })
    kernel.log.info({ socket: s.id, userId: s.principal.userId, channel: name }, 'ws subscription revoked')
  }

  /**
   * Deliver one message to one socket, re-authorising the subscription first when the answer that
   * admitted it has gone stale.
   *
   * Authorising once at `sub` time is what let somebody removed from a private channel — or from
   * the workspace — go on reading it: HTTP refused them on the next request and the shell hid the
   * channel, while the socket they already held delivered every message posted afterwards. Asking
   * again on *every* message would put a database read on the hot path, so the answer is cached
   * per socket and channel; the revocation events below expire or drop it the moment access
   * changes, and `WS_REAUTH_INTERVAL_MS` is the ceiling for anything they do not reach.
   *
   * Messages that arrive while a check is in flight are held rather than sent optimistically: the
   * message a refusal would stop is exactly the one that must not go out.
   */
  const deliver = (s: Socket, name: string, msg: Record<string, unknown>) => {
    const sub = s.channels.get(name)
    if (!sub) return
    if (sub.pending) {
      if (sub.pending.length < MAX_HELD_MESSAGES) sub.pending.push(msg)
      return
    }
    if (Date.now() - sub.checkedAt < env.WS_REAUTH_INTERVAL_MS) {
      sendSeq(s, msg)
      return
    }
    sub.pending = [msg]
    void reauthorize(s, name).then(({ allowed, answered }) => {
      const held = sub.pending ?? []
      sub.pending = null
      // the socket may have unsubscribed, or been revoked, while the check was in flight
      if (s.channels.get(name) !== sub) return
      if (allowed) {
        sub.checkedAt = Date.now()
        for (const m of held) sendSeq(s, m)
      } else if (answered) revoke(s, name)
      // Unanswerable: nothing is delivered and the subscription stays stale, so the next message
      // asks again. A database that cannot answer must not deliver — and must not unsubscribe
      // every socket in the instance over a blip either, because the client only re-subscribes
      // when it reconnects.
    })
  }

  /** `authorize`, separating "no" from "could not say". Never rejects. */
  const reauthorize = (s: Socket, name: string): Promise<{ allowed: boolean; answered: boolean }> =>
    authorize(s, name).then(
      (allowed) => ({ allowed, answered: true }),
      (err) => {
        kernel.log.warn({ err, socket: s.id, channel: name }, 'ws re-authorisation could not be answered')
        return { allowed: false, answered: false }
      },
    )

  /** fan a message out to every local socket subscribed to `name` */
  const toChannel = (name: string, msg: Record<string, unknown>, exceptSocket?: string) => {
    for (const id of [...(subscribers.get(name) ?? [])]) {
      if (id === exceptSocket) continue
      const s = sockets.get(id)
      if (s) deliver(s, name, msg)
    }
  }
  const toUser = (userId: string, msg: Record<string, unknown>) => {
    for (const s of socketsOf(userId)) sendSeq(s, msg)
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
  /**
   * Presence is best-effort, so every call to it swallows its own failure.
   *
   * The first heartbeat after Valkey became unreachable used to reject with nobody listening, and
   * an unhandled rejection ends the process — which `restart: unless-stopped` then turns into a
   * crash loop for as long as Valkey is away. Nobody's chat should stop working because the
   * green dot beside their name cannot be written.
   */
  const presenceFailed = (err: unknown, userId: string) =>
    kernel.log.warn({ err, userId }, 'presence write failed; chat is unaffected')
  // The stored shape is what `readPresence` (chat module, `chat.presence.get`) parses: a bare status
  // string reads back as a plain "online" and loses both the chosen status and the last-seen time.
  const setPresence = async (userId: string, status: string) => {
    try {
      await kernel.redis?.set(
        presenceKey(userId),
        JSON.stringify({ status, at: Date.now() }),
        'EX',
        env.PRESENCE_TTL_SEC,
      )
    } catch (err) {
      presenceFailed(err, userId)
    }
  }
  const clearPresence = async (userId: string) => {
    try {
      await kernel.redis?.del(presenceKey(userId))
    } catch (err) {
      presenceFailed(err, userId)
    }
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

  // ---- revocation: a socket must stop delivering what its holder may no longer read ----

  /** Ask again for this socket's subscriptions now, and drop the ones that no longer hold. */
  async function revalidate(s: Socket, only?: (name: string) => boolean) {
    for (const [name, sub] of [...s.channels]) {
      if (name === chan.user(s.principal.userId ?? '')) continue
      if (only && !only(name)) continue
      const { allowed, answered } = await reauthorize(s, name)
      if (s.channels.get(name) !== sub) continue
      if (allowed) sub.checkedAt = Date.now()
      else if (answered) revoke(s, name)
      // could not say: leave it stale, so the next message on it asks again before delivering
      else sub.checkedAt = 0
    }
  }

  /**
   * Mark subscriptions for a fresh answer without asking for one yet.
   *
   * `core.permissions.changed` can name every member of a workspace at once, and re-authorising all
   * of their chat channels immediately would answer one role change with thousands of database
   * reads. Expiring costs nothing: the next message on each channel pays for its own check, and a
   * channel with no traffic has nothing to leak.
   */
  const expire = (s: Socket) => {
    for (const sub of s.channels.values()) sub.checkedAt = 0
  }

  const revocationSubs: Array<() => void> = []
  let stopped = false
  /**
   * Subscribe to a revocation signal.
   *
   * The durable is named for the gateway rather than left to default. `@kernhq/kernel` already
   * takes a `core.permissions.changed` subscription under `<service>-core.permissions.changed`, and
   * two pull consumers sharing one durable **load-balance** the stream — so a shared name would
   * hand half the revocations to the kernel's cache invalidation and half to us, at random.
   */
  const onRevocation = (pattern: string, handler: (e: EventEnvelope) => Promise<void>) => {
    kernel.events
      .subscribe(pattern, handler, { durable: `${kernel.service}-gateway-${pattern}` })
      .then((unsub) => (stopped ? unsub() : revocationSubs.push(unsub)))
      .catch((err) => kernel.log.error({ err, pattern }, 'gateway could not subscribe to revocations'))
  }

  // Removed from the workspace. The socket's principal still carries the membership, so strip it
  // first: `authorize` reads memberships and would otherwise go on saying yes from stale data.
  onRevocation('core.member.removed', async (e) => {
    const { workspaceId, userId } = (e.payload ?? {}) as { workspaceId?: string; userId?: string }
    if (!workspaceId || !userId) return
    for (const s of socketsOf(userId)) {
      s.principal = {
        ...s.principal,
        memberships: s.principal.memberships.filter((m) => m.workspaceId !== workspaceId),
      }
      await revalidate(s)
    }
  })

  // Removed from one channel. Cheap and exact: only that channel, only that person's sockets.
  onRevocation('chat.channel.member_removed', async (e) => {
    const { channelId, userId } = (e.payload ?? {}) as { channelId?: string; userId?: string }
    if (!channelId || !userId) return
    const name = chan.chat(channelId)
    for (const s of socketsOf(userId)) await revalidate(s, (n) => n === name)
  })

  // A role, group or binding change can take away a private channel without touching membership.
  onRevocation('core.permissions.changed', async (e) => {
    const { workspaceId, userIds } = (e.payload ?? {}) as {
      workspaceId?: string
      userIds?: string[] | null
    }
    if (!workspaceId) return
    const affected = userIds?.length
      ? userIds.flatMap(socketsOf)
      : [...sockets.values()].filter((s) =>
          s.principal.memberships.some((m) => m.workspaceId === workspaceId),
        )
    for (const s of affected) expire(s)
  })

  /**
   * Answer a `hello`, and publish the attempt as `s.authenticating`.
   *
   * A client sends `hello` and its `sub` back to back, so both frames usually arrive in one read and
   * are dispatched in the same tick — while this function is still awaiting core. Without something
   * for the second message to wait on, it was met by a socket that was not authenticated *yet* and
   * closed as unauthorized, which the client answered by reconnecting into the same race.
   */
  function onHello(s: Socket, msg: Extract<ClientMessage, { t: 'hello' }>) {
    const attempt = authenticate(s, msg).finally(() => {
      if (s.authenticating === attempt) s.authenticating = null
    })
    s.authenticating = attempt
    return attempt
  }

  async function authenticate(s: Socket, msg: Extract<ClientMessage, { t: 'hello' }>) {
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
    if (!users) {
      users = new Set()
      byUser.set(principal.userId, users)
    }
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
    // a `sub` that overtook its own `hello` is not an unauthenticated client, it is an early one
    if (!s.authenticated && s.authenticating) await s.authenticating
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
    for (const name of s.channels.keys()) {
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
      void clearPresence(userId).catch((err) => presenceFailed(err, userId))
      broadcastPresence(s.principal, 'offline')
    }
  }

  wss.on('connection', (ws: WebSocket, req?: IncomingMessage) => {
    const s: Socket = {
      id: randomUUID(),
      ws,
      cookie: req?.headers.cookie ?? null,
      principal: ANONYMOUS,
      channels: new Map(),
      seq: 0,
      alive: true,
      missedPings: 0,
      authenticated: false,
      authenticating: null,
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
      // Nothing awaits this heartbeat, so it carries its own catch: an unhandled rejection here
      // ends the process, and `restart: unless-stopped` re-runs the same failing heartbeat.
      const userId = s.principal.userId
      if (userId) void setPresence(userId, 'online').catch((err) => presenceFailed(err, userId))
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
      stopped = true
      clearInterval(heartbeat)
      for (const sub of natsSubs) sub.unsubscribe()
      for (const unsub of revocationSubs.splice(0)) unsub()
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
