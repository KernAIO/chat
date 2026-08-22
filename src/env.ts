/**
 * Loads `.env` (repo-local, then the umbrella dev workspace) outside production and validates the
 * chat-specific environment. Kernel-level variables are validated by `@kernalo/kernel`.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

if (process.env.NODE_ENV !== 'production') {
  const here = dirname(fileURLToPath(import.meta.url))
  loadDotenv({ path: resolve(here, '../.env'), quiet: true })
  loadDotenv({ path: resolve(here, '../../../.env'), quiet: true })
}

export const ChatEnv = z.object({
  /** how long a client may take to send `hello` before the socket is closed */
  WS_HELLO_TIMEOUT_MS: z.coerce.number().int().default(10_000),
  /** server-side ping interval; sockets missing two consecutive pings are terminated */
  WS_PING_INTERVAL_MS: z.coerce.number().int().default(30_000),
  /** presence key TTL in Valkey; refreshed by pings */
  PRESENCE_TTL_SEC: z.coerce.number().int().default(60),
  /** minimum interval between typing broadcasts per user and channel */
  TYPING_THROTTLE_MS: z.coerce.number().int().default(2_000),
  /** maximum concurrent sockets per user (older ones are closed) */
  MAX_SOCKETS_PER_USER: z.coerce.number().int().default(12),
})
export type ChatEnv = z.infer<typeof ChatEnv>

export function loadChatEnv(extra: Record<string, string | undefined> = {}): ChatEnv {
  const parsed = ChatEnv.safeParse({ ...process.env, ...extra })
  if (!parsed.success) {
    throw new Error(
      `Invalid chat environment:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    )
  }
  return parsed.data
}
