/**
 * The gateway's two failure modes, driven without a database.
 *
 * `createGateway` takes every dependency as an option, so a stub kernel and a stub `canJoinChannel`
 * reach what an integration suite cannot: what the delivery path does when the answer that admitted
 * a subscription has gone stale and no revocation event is coming, and what the heartbeat does when
 * the presence backend is unreachable.
 */
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ANONYMOUS, type Principal } from '@kernhq/contracts'
import type { Kernel } from '@kernhq/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { loadChatEnv } from '../env.js'
import { createGateway, type Gateway, rtSubject } from '../gateway.js'
import { connect, type TestSocket } from '../testing/harness.js'

const here = dirname(fileURLToPath(import.meta.url))
const run = promisify(execFile)

const WORKSPACE = '01920000-0000-7000-8000-0000000000a1'
const CHANNEL = '01920000-0000-7000-8000-0000000000b1'
const USER = '01920000-0000-7000-8000-0000000000c1'
const TOKEN = 'token-for-the-stub-principal'

const watcher: Principal = {
  kind: 'user',
  userId: USER as Principal['userId'],
  email: 'watcher@example.test',
  name: 'Watcher',
  locale: 'en',
  instanceAdmin: false,
  service: null,
  memberships: [
    {
      workspaceId: WORKSPACE as Principal['memberships'][number]['workspaceId'],
      role: 'member',
      roleIds: [],
      groupIds: [],
      status: 'active',
    },
  ],
  permissionVersion: 0,
}

interface StubGateway {
  gateway: Gateway
  url: string
  server: Server
}

const started: StubGateway[] = []
const openSockets: TestSocket[] = []

interface StubOptions {
  /** stands in for Valkey; omitted means presence is not stored at all */
  redis?: unknown
  env?: Record<string, string | undefined>
  canJoinChannel?: () => Promise<boolean>
}

async function startGateway(opts: StubOptions = {}): Promise<StubGateway> {
  const noop = () => {}
  const kernel = {
    service: 'chat',
    log: { debug: noop, info: noop, warn: noop, error: noop },
    redis: opts.redis,
    nats: undefined,
    // no revocation events are delivered here on purpose: these tests are about the paths that
    // hold when nothing tells the gateway that access changed.
    events: { subscribe: async () => noop },
  } as unknown as Kernel

  const gateway = createGateway({
    kernel,
    env: loadChatEnv({
      WS_HELLO_TIMEOUT_MS: '2000',
      WS_PING_INTERVAL_MS: '30000',
      WS_REAUTH_INTERVAL_MS: '60000',
      ...opts.env,
    }),
    resolvePrincipal: async (token) => (token === TOKEN ? watcher : ANONYMOUS),
    resolvePrincipalFromCookie: async () => ANONYMOUS,
    canJoinChannel: opts.canJoinChannel ?? (async () => true),
  })
  const server = createServer()
  gateway.attach(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const stub = { gateway, server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws` }
  started.push(stub)
  return stub
}

async function connectWatcher(url: string): Promise<TestSocket> {
  const socket = await connect(url)
  openSockets.push(socket)
  socket.send({ t: 'hello', token: TOKEN, clientId: 'stub-tab' })
  await socket.next((m) => m.t === 'welcome')
  return socket
}

const change = (marker: string) => ({
  t: 'change',
  workspaceId: WORKSPACE,
  change: { module: 'chat', entity: 'message', id: CHANNEL, op: 'created', patch: { bodyText: marker } },
})

afterEach(async () => {
  for (const s of openSockets.splice(0)) s.close()
  for (const s of started.splice(0)) {
    await s.gateway.close()
    s.server.closeAllConnections()
    await new Promise<void>((done) => s.server.close(() => done()))
  }
})

describe('re-authorisation on delivery', () => {
  it('drops a subscription whose authorisation no longer holds, without sending the message', async () => {
    // The backstop under the revocation events: nothing here publishes one, so the only thing that
    // can stop the delivery is the gateway asking again because its answer went stale.
    let allowed = true
    const stub = await startGateway({
      canJoinChannel: async () => allowed,
      env: { WS_REAUTH_INTERVAL_MS: '0' },
    })
    const socket = await connectWatcher(stub.url)
    socket.send({ t: 'sub', channels: [`chat:${CHANNEL}`] })
    await new Promise((r) => setTimeout(r, 50))
    expect(socket.received.filter((m) => m.t === 'error')).toEqual([])

    stub.gateway.deliverLocal(rtSubject.channel(`chat:${CHANNEL}`), change('while allowed'))
    await socket.next((m) => m.t === 'change')

    allowed = false
    stub.gateway.deliverLocal(rtSubject.channel(`chat:${CHANNEL}`), change('after revocation'))
    const refusal = await socket.next<{ code: string; message: string }>((m) => m.t === 'error')
    expect(refusal.code).toBe('FORBIDDEN')
    expect(refusal.message).toContain(CHANNEL)

    await new Promise((r) => setTimeout(r, 100))
    expect(
      JSON.stringify(socket.received),
      'the message that the refusal answered must never be delivered',
    ).not.toContain('after revocation')
    // only the two the socket is given at `hello` are left: its own user channel and its workspace
    expect(stub.gateway.stats().subscriptions).toBe(2)
  })

  it('keeps delivering while the cached answer is still fresh', async () => {
    let asked = 0
    const stub = await startGateway({
      canJoinChannel: async () => {
        asked++
        return true
      },
    })
    const socket = await connectWatcher(stub.url)
    socket.send({ t: 'sub', channels: [`chat:${CHANNEL}`] })
    await new Promise((r) => setTimeout(r, 50))

    for (let i = 0; i < 5; i++)
      stub.gateway.deliverLocal(rtSubject.channel(`chat:${CHANNEL}`), change(`burst ${i}`))
    await socket.next((m) => m.t === 'change' && JSON.stringify(m).includes('burst 4'))
    expect(asked, 'a fresh answer must not put a database read on the hot path').toBe(1)
  })

  it('delivers nothing, and unsubscribes nothing, when the check cannot be answered', async () => {
    // A database that cannot say yes must not deliver. It must not unsubscribe every socket in the
    // instance over a blip either: the client only re-sends its subscriptions when it reconnects.
    let answerable = false
    const stub = await startGateway({
      canJoinChannel: async () => {
        if (!answerable) throw new Error('the database is not answering')
        return true
      },
      env: { WS_REAUTH_INTERVAL_MS: '0' },
    })
    const socket = await connectWatcher(stub.url)
    answerable = true
    socket.send({ t: 'sub', channels: [`chat:${CHANNEL}`] })
    await new Promise((r) => setTimeout(r, 50))

    answerable = false
    stub.gateway.deliverLocal(rtSubject.channel(`chat:${CHANNEL}`), change('during the outage'))
    await new Promise((r) => setTimeout(r, 150))
    expect(JSON.stringify(socket.received)).not.toContain('during the outage')
    expect(socket.received.filter((m) => m.t === 'error')).toEqual([])
    expect(stub.gateway.stats().subscriptions, 'the subscription is kept, not revoked').toBe(3)

    answerable = true
    stub.gateway.deliverLocal(rtSubject.channel(`chat:${CHANNEL}`), change('after recovery'))
    const resumed = await socket.next((m) => m.t === 'change')
    expect(JSON.stringify(resumed)).toContain('after recovery')
  })
})

describe('a presence backend that is down', () => {
  it('does not take the process with it', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      const down = () => Promise.reject(new Error('valkey unreachable'))
      const stub = await startGateway({
        redis: { set: down, del: down },
        // fast enough that several heartbeats — and so several pongs, the path that used to throw —
        // happen inside the test
        env: { WS_PING_INTERVAL_MS: '60' },
      })
      const socket = await connectWatcher(stub.url) // `hello` writes presence
      socket.send({ t: 'presence', status: 'away' }) // so does a client-driven status
      await new Promise((r) => setTimeout(r, 300))

      // the socket is still serving after every one of those writes failed
      stub.gateway.deliverLocal(rtSubject.user(USER), {
        t: 'notification',
        notification: { title: 'still connected' },
      })
      const delivered = await socket.next<{ notification: { title: string } }>((m) => m.t === 'notification')
      expect(delivered.notification.title).toBe('still connected')

      socket.close() // closing clears presence, which fails too
      await new Promise((r) => setTimeout(r, 150))
      expect(rejections, 'a failed presence write must never reach the process').toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})

describe('the unhandled-rejection guard', () => {
  const fixture = resolve(here, 'fixtures/floating-rejection.ts')
  const tsx = resolve(here, '../../node_modules/.bin/tsx')

  it('keeps a service alive through a floating promise that rejects', async () => {
    const { stdout } = await run(tsx, [fixture], { env: { ...process.env, KERN_GUARD: 'on' } })
    expect(stdout.trim()).toBe('alive logged=1')
  }, 30_000)

  it('is what keeps it alive — without it the process dies', async () => {
    // Proves the assertion above is measuring the guard and not the runtime being lenient.
    const failed = await run(tsx, [fixture], { env: { ...process.env, KERN_GUARD: 'off' } }).then(
      () => null,
      (err: { code?: number; stdout?: string }) => err,
    )
    expect(failed, 'node must still die of an unhandled rejection when nothing handles it').not.toBeNull()
    expect(failed?.stdout ?? '').not.toContain('alive')
  }, 30_000)
})
