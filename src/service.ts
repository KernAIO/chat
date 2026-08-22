import { channel as chan } from '@kernhq/contracts'
import { createHttpServer, createKernel, type Kernel, rtSubject } from '@kernhq/kernel'
import { chatModule, chatServices } from '@kernhq/module-chat/server'
import type { FastifyInstance } from 'fastify'
import { type ChatEnv, loadChatEnv } from './env.js'
import { createGateway, type Gateway } from './gateway.js'
import { createPrincipals, type Principals } from './principal.js'

export interface ChatServiceOptions {
  role?: 'api' | 'worker' | 'both'
  env?: Record<string, string | undefined>
}

export interface ChatService {
  kernel: Kernel
  env: ChatEnv
  app: FastifyInstance | null
  gateway: Gateway | null
  principals: Principals
  stop(): Promise<void>
}

export const CHAT_VERSION = '0.1.0'

/**
 * Boots the chat service: the chat module (channels, messages, read state) plus the realtime gateway
 * that every Kern module shares. `main.ts` is a thin wrapper; tests boot this against a scratch database.
 */
export async function createChatService(opts: ChatServiceOptions = {}): Promise<ChatService> {
  const role = opts.role ?? 'both'
  const env = loadChatEnv(opts.env ?? {})
  const kernel = await createKernel({
    service: 'chat',
    version: CHAT_VERSION,
    modules: [chatModule],
    role,
    env: { PORT: process.env.PORT ?? '4100', ...opts.env },
  })
  await kernel.start()

  const principals = createPrincipals(kernel)
  let app: FastifyInstance | null = null
  let gateway: Gateway | null = null

  if (role !== 'worker') {
    gateway = createGateway({
      kernel,
      env,
      resolvePrincipal: (token) => principals.fromToken(token),
      resolvePrincipalFromCookie: (cookie) => principals.fromCookie(cookie),
      canJoinChannel: async (principal, _workspaceId, channelId) => {
        if (principal.instanceAdmin || principal.kind === 'service') return true
        if (!principal.userId) return false
        const access = await chatServices(kernel).channels.access(principal.userId, channelId)
        if (!access?.canRead) return false
        // `access` is cross-workspace, so confirm the subscriber belongs to the owning workspace.
        return principal.memberships.some(
          (m) => m.workspaceId === access.channel.workspaceId && m.status === 'active',
        )
      },
    })
    // Realtime published inside this process reaches local sockets directly; NATS carries it to the
    // other replicas. Without this hook a single-node deployment would need NATS to talk to itself.
    kernel.realtime = wrapRealtime(kernel, gateway)

    const corsOrigins = [
      ...new Set(
        [kernel.env.KERN_BASE_URL, ...(kernel.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim())].filter(
          Boolean,
        ),
      ),
    ]
    app = await createHttpServer({
      kernel,
      resolvePrincipal: (req) => principals.fromRequest(req),
      corsOrigins,
      openapi: { title: 'Kern', version: CHAT_VERSION },
      extend: async (fastify) => {
        fastify.get('/api/chat/metrics', async () => ({
          service: 'chat',
          ...(gateway?.stats() ?? { sockets: 0, users: 0, subscriptions: 0 }),
        }))
      },
    })
  }

  return {
    kernel,
    env,
    app,
    gateway,
    principals,
    async stop() {
      await gateway?.close()
      await app?.close()
      await kernel.stop()
    },
  }
}

/** Tees realtime publishes into the local gateway in addition to NATS. */
function wrapRealtime(kernel: Kernel, gateway: Gateway): Kernel['realtime'] {
  const inner = kernel.realtime
  const toChannel: Kernel['realtime']['toChannel'] = async (ch, msg) => {
    gateway.deliverLocal(rtSubject.channel(ch), msg)
    await inner.toChannel(ch, msg)
  }
  const toUser: Kernel['realtime']['toUser'] = async (userId, msg) => {
    gateway.deliverLocal(rtSubject.user(userId), msg)
    await inner.toUser(userId, msg)
  }
  return {
    toChannel,
    toUser,
    async toUsers(userIds, msg) {
      await Promise.all(userIds.map((id) => toUser(id, msg)))
    },
    // `inner.change` publishes straight to NATS, which never comes back to this process. Entity
    // changes have to go through the teed `toChannel` as well or nothing reaches a socket on a
    // single-node deployment (and, with NATS, the local sockets take a needless round trip).
    async change(workspaceId, change) {
      const msg = { t: 'change', workspaceId, change } as const
      await toChannel(chan.workspace(workspaceId), msg as never)
      await toChannel(chan.object(workspaceId, change.module, change.id), msg as never)
    },
  }
}
