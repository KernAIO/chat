import { createChatService } from './service.js'

const svc = await createChatService({ role: 'both' })
const { kernel, app, gateway } = svc
if (!app) throw new Error('chat service started without an HTTP server')

await app.listen({ port: kernel.env.PORT, host: kernel.env.HOST })
gateway?.attach(app.server)
kernel.log.info({ port: kernel.env.PORT }, 'chat service listening')

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  kernel.log.info({ signal }, 'shutting down')
  const timer = setTimeout(() => process.exit(1), 15_000)
  timer.unref()
  try {
    await svc.stop()
    process.exit(0)
  } catch (err) {
    kernel.log.error({ err }, 'shutdown failed')
    process.exit(1)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
