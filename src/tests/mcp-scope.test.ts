import type { Principal } from '@kernhq/contracts'
import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { createPrincipals, needForRequest } from '../principal.js'

/**
 * This service does not own the identity tables, so it cannot decide what an MCP token may do — it
 * asks core. Core cannot decide either unless it is told what the token is being used *for*: it
 * holds a `kmt_…` token to the `<module>:<read|write>` scopes its consent screen named, and it does
 * not have this request.
 *
 * The call used to carry the token alone, so an MCP token resolved into its owner's full principal
 * here and a read-only one could write. `/api/chat/*` is routed to this service from the edge in
 * every shipped Caddyfile, so that was reachable from the internet.
 *
 * What is tested here is this side of the boundary: that the need is worked out from the request
 * and reaches core. Core's own enforcement is proved in its `mcp.test.ts`.
 */

const CHAT_MODULE = { definition: { id: 'chat' } }

function stubKernel(answer: Principal) {
  const calls: Array<Record<string, unknown>> = []
  const kernel = {
    call: async (_name: string, input: Record<string, unknown>) => {
      calls.push(input)
      return answer
    },
    log: { warn() {} },
    registry: { all: () => [CHAT_MODULE] },
  }
  return { kernel: kernel as never, calls }
}

const req = (method: string, url: string) => ({ method, url }) as FastifyRequest

const principal = { kind: 'user', userId: 'u1', memberships: [] } as unknown as Principal

describe('the need a request expresses', () => {
  it('names the module and the direction for a module API call', () => {
    const { kernel } = stubKernel(principal)
    expect(needForRequest(kernel, req('GET', '/api/chat/channels?workspaceId=w1'))).toEqual({
      module: 'chat',
      write: false,
    })
    expect(needForRequest(kernel, req('POST', '/api/chat/channels'))).toEqual({
      module: 'chat',
      write: true,
    })
    expect(needForRequest(kernel, req('DELETE', '/api/chat/channels/c1'))?.write).toBe(true)
  })

  /** A socket upgrade is not a module API call, so an MCP token has nothing to be held to there. */
  it('is null for the socket, for health, and for a prefix that only looks like the module', () => {
    const { kernel } = stubKernel(principal)
    expect(needForRequest(kernel, req('GET', '/ws'))).toBeNull()
    expect(needForRequest(kernel, req('GET', '/api/health'))).toBeNull()
    expect(needForRequest(kernel, req('POST', '/api/chatter/things'))).toBeNull()
  })
})

describe('what reaches core', () => {
  it('sends the module and direction the request expressed', async () => {
    const { kernel, calls } = stubKernel(principal)
    const p = createPrincipals(kernel)
    await p.fromRequest({
      ...req('POST', '/api/chat/channels'),
      headers: { authorization: 'Bearer kmt_abc' },
    } as FastifyRequest)
    expect(calls).toEqual([{ token: 'kmt_abc', module: 'chat', write: true }])
  })

  /**
   * The trap. The cache was keyed on the token alone, so the first GET would have answered every
   * later POST from its entry — core would be asked once, about a read, and the write would be
   * waved through on a cached answer. With the key fixed this is two questions.
   */
  it('does not answer a write from the entry a read put in the cache', async () => {
    const { kernel, calls } = stubKernel(principal)
    const p = createPrincipals(kernel)
    const get = { ...req('GET', '/api/chat/channels'), headers: { authorization: 'Bearer kmt_abc' } }
    const post = { ...req('POST', '/api/chat/channels'), headers: { authorization: 'Bearer kmt_abc' } }
    await p.fromRequest(get as FastifyRequest)
    await p.fromRequest(post as FastifyRequest)
    expect(calls).toEqual([
      { token: 'kmt_abc', module: 'chat', write: false },
      { token: 'kmt_abc', module: 'chat', write: true },
    ])
    // and the read is still cached as a read
    await p.fromRequest(get as FastifyRequest)
    expect(calls).toHaveLength(2)
  })

  /** The gateway resolves a `hello` token with no request behind it, so it states no need. */
  it('states no need for a socket token, which is what makes core refuse an MCP one', async () => {
    const { kernel, calls } = stubKernel(principal)
    const p = createPrincipals(kernel)
    await p.fromToken('kmt_abc')
    expect(calls).toEqual([{ token: 'kmt_abc' }])
  })

  it('still resolves a session cookie with no need stated', async () => {
    const { kernel, calls } = stubKernel(principal)
    const p = createPrincipals(kernel)
    const seen = await p.fromCookie('kern.session_token=sess-1')
    expect(seen.kind).toBe('user')
    expect(calls).toEqual([{ token: 'sess-1' }])
  })
})
