import { ANONYMOUS, type Principal } from '@kernalo/contracts'
import type { Kernel } from '@kernalo/kernel'
import type { FastifyRequest } from 'fastify'

/**
 * Resolves principals for a service that does not own the identity tables: the session token is handed
 * to core (`core.users.principal`), and the answer is cached briefly so that a burst of requests or a
 * WebSocket handshake storm does not amplify into core.
 */
export interface Principals {
  fromToken(token: string): Promise<Principal>
  fromRequest(req: FastifyRequest): Promise<Principal>
  invalidate(token?: string): void
}

export function createPrincipals(kernel: Kernel, ttlMs = 60_000): Principals {
  const cache = new Map<string, { principal: Principal; expires: number }>()

  const fromToken = async (token: string): Promise<Principal> => {
    if (!token) return ANONYMOUS
    const hit = cache.get(token)
    if (hit && hit.expires > Date.now()) return hit.principal
    const principal = await kernel
      .call<Principal>('core.users.principal', { token })
      .catch((err): Principal => {
        kernel.log.warn({ err }, 'principal lookup failed')
        return ANONYMOUS
      })
    if (principal.kind !== 'anonymous') cache.set(token, { principal, expires: Date.now() + ttlMs })
    return principal
  }

  return {
    fromToken,
    async fromRequest(req) {
      const service = req.headers['x-kern-service']
      if (typeof service === 'string') {
        const name = await kernel.auth.verifyService(service)
        if (name) return { ...ANONYMOUS, kind: 'service', service: name, instanceAdmin: true }
      }
      const auth = req.headers.authorization
      if (auth?.startsWith('Bearer ')) return fromToken(auth.slice(7))
      const cookie = req.headers.cookie
      if (cookie) {
        const match = /(?:^|;\s*)(?:__Secure-)?kern\.session_token=([^;]+)/.exec(cookie)
        if (match?.[1]) return fromToken(decodeURIComponent(match[1]))
      }
      return ANONYMOUS
    },
    invalidate(token) {
      if (token) cache.delete(token)
      else cache.clear()
    },
  }
}
