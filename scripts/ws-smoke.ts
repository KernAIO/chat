/**
 * Manual smoke test for the realtime gateway.
 *   pnpm smoke -- <session-token>
 * Signs the socket in, subscribes to the user's channels and prints everything the server sends.
 */
import { WebSocket } from 'ws'

const token = process.env.KERN_TOKEN ?? process.argv.slice(2).find((a) => a !== '--')
if (!token) {
  console.error('usage: KERN_TOKEN=<session-token> pnpm smoke')
  process.exit(1)
}
const url = process.env.WS_URL ?? 'ws://localhost:4100/ws'
const ws = new WebSocket(url)

ws.on('open', () => {
  console.log('→ open', url)
  ws.send(JSON.stringify({ t: 'hello', token, clientId: 'smoke' }))
})
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  console.log('←', JSON.stringify(msg))
  if (msg.t === 'welcome') {
    ws.send(JSON.stringify({ t: 'presence', status: 'online' }))
    ws.send(JSON.stringify({ t: 'ping' }))
  }
})
ws.on('close', (code, reason) => {
  console.log('× closed', code, reason.toString())
  process.exit(0)
})
ws.on('error', (err) => {
  console.error('error', err)
  process.exit(1)
})
setTimeout(() => ws.close(), 5_000).unref()
