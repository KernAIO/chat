/**
 * Integration harness for the chat service.
 *
 * The chat service does not own identity, so the suites do not start core: the handful of core
 * procedures chat calls are registered as local procedures on the kernel broker (`kernel.call` resolves
 * them in-process), which keeps the tests hermetic and lets them assert *what* chat asked core for.
 *
 * Everything else is real: the chat module's own migrations run in a scratch database, the router is
 * the one the HTTP server mounts, and the realtime gateway is the one `main.ts` attaches.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANONYMOUS, type MembershipSummary, type Principal } from '@kernhq/contracts'
import type { Kernel, RequestContext } from '@kernhq/kernel'
import { uuidv7 } from '@kernhq/kernel'
import type { ChatContract } from '@kernhq/module-chat/contract'
import { chatContract } from '@kernhq/module-chat/contract'
import { createScratchDatabase } from '@kernhq/testing'
import type { ContractRouterClient } from '@orpc/contract'
import { createRouterClient } from '@orpc/server'
import { config as loadDotenv } from 'dotenv'
import { type ChatService, createChatService } from '../service.js'

const here = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(here, '../../.env'), quiet: true })
loadDotenv({ path: resolve(here, '../../../../.env'), quiet: true })

export const BASE_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const TEST_SECRET = process.env.KERN_SECRET ?? 'kern-test-secret-value-at-least-32-chars'

export type ChatApi = ContractRouterClient<ChatContract>

/** A call chat made into another service, recorded so tests can assert the cross-module contract. */
export interface RecordedCall {
  name: string
  input: unknown
}

export interface TestActor {
  id: string
  name: string
  /** session token the gateway accepts for this actor */
  token: string
  principal: Principal
  api: ChatApi
}

export interface TestChat {
  service: ChatService
  kernel: Kernel
  workspaceId: string
  /** every `kernel.call` chat made to a stubbed core procedure, in order */
  calls: RecordedCall[]
  /** notifications core was asked to create */
  notifications: Array<Record<string, unknown>>
  /** documents core was asked to index */
  indexed: Array<Record<string, unknown>>
  actor(name: string, over?: Partial<Principal> & { role?: MembershipSummary['role'] }): TestActor
  /** an actor that belongs to a different workspace */
  outsider(name: string): TestActor
  api(principal: Principal): ChatApi
  service_api: ChatApi
  /** start listening so WebSocket clients can connect; returns ws://…/ws */
  listen(): Promise<string>
  stop(): Promise<void>
}

const unique = () => `${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`

export interface StartChatOptions {
  env?: Record<string, string | undefined>
  /** extra broker procedures (or overrides) registered before the tests run */
  procedures?: Record<string, (input: unknown, principal: Principal) => Promise<unknown> | unknown>
}

export async function startChat(opts: StartChatOptions = {}): Promise<TestChat> {
  const scratch = await createScratchDatabase(BASE_DATABASE_URL, `kern_test_chat_${unique()}`)
  const workspaceId = uuidv7()
  const service = await createChatService({
    role: 'api',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: scratch.url,
      DATABASE_POOL_MAX: '4',
      KERN_SECRET: TEST_SECRET,
      PORT: '0',
      NATS_URL: undefined,
      VALKEY_URL: undefined,
      ...opts.env,
    },
  })
  const kernel = service.kernel

  const calls: RecordedCall[] = []
  const notifications: Array<Record<string, unknown>> = []
  const indexed: Array<Record<string, unknown>> = []
  const users = new Map<string, { id: string; name: string; username: string | null; avatarUrl: null }>()
  const principals = new Map<string, Principal>()
  const tokens = new Map<string, Principal>()

  const record =
    <T>(name: string, handler: (input: T) => unknown) =>
    async (input: unknown) => {
      calls.push({ name, input })
      return handler(input as T)
    }

  // The slice of core the chat module actually calls. Registering them locally means `kernel.call`
  // never leaves the process, so a suite is not affected by whatever the real core is doing.
  kernel.broker.register('core', {
    'users.getMany': {
      handler: record('core.users.getMany', (input: { ids?: string[] }) =>
        (input.ids ?? []).map(
          (id) => users.get(id) ?? { id, name: 'Unknown', username: null, avatarUrl: null },
        ),
      ),
    },
    'users.principal': {
      handler: record('core.users.principal', (input: { token?: string; userId?: string }) => {
        if (input.token) return tokens.get(input.token) ?? ANONYMOUS
        return (input.userId && principals.get(input.userId)) || ANONYMOUS
      }),
    },
    'workspaces.members': {
      handler: record('core.workspaces.members', (input: { workspaceId: string }) =>
        [...principals.values()]
          .filter((p) => p.memberships.some((m) => m.workspaceId === input.workspaceId))
          .map((p) => ({ userId: p.userId, role: 'member', roleIds: [], groupIds: [], status: 'active' })),
      ),
    },
    'modules.isEnabled': { handler: record('core.modules.isEnabled', () => true) },
    'authz.customRolePermissions': { handler: record('core.authz.customRolePermissions', () => []) },
    'authz.bindings': { handler: record('core.authz.bindings', () => []) },
    'notifications.create': {
      handler: record('core.notifications.create', (input: Record<string, unknown>) => {
        notifications.push(input)
        return { ...input, id: uuidv7() }
      }),
    },
    'activity.record': { handler: record('core.activity.record', () => ({ ok: true })) },
    'search.index': {
      handler: record('core.search.index', (input: { documents?: Array<Record<string, unknown>> }) => {
        for (const d of input.documents ?? []) indexed.push(d)
        return { indexed: input.documents?.length ?? 0 }
      }),
    },
    'search.remove': { handler: record('core.search.remove', () => ({ removed: 1 })) },
    'files.get': { handler: record('core.files.get', (input: { id: string }) => ({ id: input.id })) },
    ...Object.fromEntries(
      Object.entries(opts.procedures ?? {}).map(([name, handler]) => [
        name.replace(/^core\./, ''),
        { handler: (input: unknown, ctx: { principal: Principal }) => handler(input, ctx.principal) },
      ]),
    ),
  })

  const router = chatRouterOf(kernel)
  const clientFor = (principal: Principal): ChatApi =>
    createRouterClient(router, {
      context: (): RequestContext => ({
        kernel,
        principal,
        requestId: `test-${randomBytes(4).toString('hex')}`,
        ip: '127.0.0.1',
        headers: {},
      }),
    }) as unknown as ChatApi

  const makeActor = (name: string, workspace: string, over: Partial<Principal> = {}): TestActor => {
    const id = uuidv7()
    const token = `tok_${randomUUID()}`
    const principal: Principal = {
      kind: 'user',
      userId: id as Principal['userId'],
      email: `${name.toLowerCase()}@example.test`,
      name,
      locale: 'en',
      instanceAdmin: false,
      service: null,
      memberships: [
        {
          workspaceId: workspace as MembershipSummary['workspaceId'],
          role: 'member',
          roleIds: [],
          groupIds: [],
          status: 'active',
        },
      ],
      permissionVersion: 0,
      ...over,
    }
    users.set(id, { id, name, username: null, avatarUrl: null })
    principals.set(id, principal)
    tokens.set(token, principal)
    return { id, name, token, principal, api: clientFor(principal) }
  }

  let baseUrl: string | null = null

  return {
    service,
    kernel,
    workspaceId,
    calls,
    notifications,
    indexed,
    api: clientFor,
    service_api: clientFor(kernel.system),
    actor(name, over = {}) {
      const { role, ...rest } = over
      const actor = makeActor(name, workspaceId, rest)
      if (role) actor.principal.memberships[0]!.role = role
      return actor
    },
    outsider(name) {
      return makeActor(name, uuidv7())
    },
    async listen() {
      if (baseUrl) return baseUrl
      const app = service.app
      if (!app) throw new Error('chat service started without an HTTP server')
      await app.listen({ port: 0, host: '127.0.0.1' })
      service.gateway?.attach(app.server)
      const address = app.server.address() as AddressInfo
      baseUrl = `ws://127.0.0.1:${address.port}/ws`
      return baseUrl
    },
    async stop() {
      await service.stop()
      await scratch.drop()
    },
  }
}

/** The chat module's own router, exactly as the HTTP server mounts it. */
function chatRouterOf(kernel: Kernel) {
  const mod = kernel.registry.get('chat')
  if (!mod?.router) throw new Error('chat module did not expose a router')
  return mod.router(kernel)
}

export { chatContract }

export function errorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; message?: unknown }
  if (typeof e?.code === 'string') return e.code
  return String(e?.name ?? e?.message ?? err)
}

export async function expectRejection(fn: () => Promise<unknown>, code: string): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    if (errorCode(err) !== code)
      throw new Error(`expected error code ${code}, got ${errorCode(err)}: ${String(err)}`)
    return err
  }
  throw new Error(`expected the call to reject with ${code}, but it resolved`)
}

/**
 * A WebSocket client that buffers everything the gateway sends, so a test can wait for the first
 * message matching a predicate without racing the socket.
 */
export interface TestSocket {
  send(msg: Record<string, unknown>): void
  /** wait for the first buffered-or-future message matching `match` */
  next<T extends Record<string, unknown>>(
    match: (msg: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<T>
  /** everything received so far */
  received: Array<Record<string, unknown>>
  /** resolves with the close code */
  closed: Promise<number>
  close(): void
}

export async function connect(url: string): Promise<TestSocket> {
  const { WebSocket } = await import('ws')
  const ws = new WebSocket(url)
  const received: Array<Record<string, unknown>> = []
  const waiters: Array<{
    match: (m: Record<string, unknown>) => boolean
    resolve: (m: Record<string, unknown>) => void
  }> = []
  let closeCode = -1
  const closed = new Promise<number>((resolve) => {
    ws.on('close', (code: number) => {
      closeCode = code
      resolve(code)
    })
  })
  ws.on('message', (data: unknown) => {
    const msg = JSON.parse(String(data)) as Record<string, unknown>
    received.push(msg)
    const i = waiters.findIndex((w) => w.match(msg))
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg)
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return {
    received,
    closed,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next<T extends Record<string, unknown>>(
      match: (m: Record<string, unknown>) => boolean,
      timeoutMs = 5_000,
    ) {
      const hit = received.find(match)
      if (hit) return Promise.resolve(hit as T)
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `timed out waiting for a message; received: ${JSON.stringify(received)}${
                closeCode >= 0 ? ` (socket closed with ${closeCode})` : ''
              }`,
            ),
          )
        }, timeoutMs)
        waiters.push({
          match,
          resolve: (m) => {
            clearTimeout(timer)
            resolve(m as T)
          },
        })
      })
    },
    close: () => ws.close(),
  }
}

/** Connect and authenticate in one step, returning the socket once `welcome` has arrived. */
export async function connectAs(url: string, actor: TestActor): Promise<TestSocket> {
  const socket = await connect(url)
  socket.send({ t: 'hello', token: actor.token, clientId: `test-${actor.name}` })
  await socket.next((m) => m.t === 'welcome')
  return socket
}

/** A minimal Tiptap document, optionally mentioning users or @channel. */
export function doc(text: string, mentions: { users?: string[]; channel?: boolean } = {}) {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text }]
  for (const id of mentions.users ?? [])
    content.push({ type: 'mention', attrs: { id, label: 'someone', kind: 'user' } })
  if (mentions.channel) content.push({ type: 'text', text: ' @channel' })
  return { type: 'doc' as const, content: [{ type: 'paragraph', content }] }
}
