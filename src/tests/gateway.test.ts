/**
 * The realtime gateway: the single WebSocket every Kern client opens.
 *
 * These suites drive real sockets against a listening server. Principals come from the stubbed
 * `core.users.principal`, which is exactly the seam the gateway uses in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  connect,
  connectAs,
  doc,
  startChat,
  type TestActor,
  type TestChat,
  type TestSocket,
} from '../testing/harness.js'

let chat: TestChat
let url: string
let alice: TestActor
let bob: TestActor
let ws: string
const open: TestSocket[] = []

let n = 0
const name = (prefix: string) => `${prefix}-${n++}-${Date.now().toString(36)}`

const track = async (socket: Promise<TestSocket>) => {
  const s = await socket
  open.push(s)
  return s
}

beforeAll(async () => {
  // Valkey is on so presence is actually stored and read back, not silently skipped.
  chat = await startChat({
    env: {
      VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
      WS_HELLO_TIMEOUT_MS: '500',
      TYPING_THROTTLE_MS: '1000',
    },
  })
  url = await chat.listen()
  ws = chat.workspaceId
  alice = chat.actor('Alice')
  bob = chat.actor('Bob')
})
afterAll(async () => {
  for (const s of open) s.close()
  await chat?.stop()
})

describe('authentication', () => {
  it('welcomes a client that presents a valid session token', async () => {
    const socket = await track(connect(url))
    socket.send({ t: 'hello', token: alice.token, clientId: 'tab-1' })

    const welcome = await socket.next<{ userId: string; resumed: boolean; serverTime: number }>(
      (m) => m.t === 'welcome',
    )
    expect(welcome.userId).toBe(alice.id)
    expect(welcome.resumed).toBe(false)
    expect(welcome.serverTime).toBeGreaterThan(0)
    expect(chat.calls.some((c) => c.name === 'core.users.principal')).toBe(true)
  })

  it('rejects an unknown token and closes the socket', async () => {
    const socket = await track(connect(url))
    socket.send({ t: 'hello', token: 'not-a-real-token', clientId: 'tab-x' })

    const error = await socket.next<{ code: string }>((m) => m.t === 'error')
    expect(error.code).toBe('UNAUTHORIZED')
    expect(await socket.closed).toBe(4401)
  })

  it('closes a socket that never says hello', async () => {
    const socket = await track(connect(url))
    const error = await socket.next<{ code: string }>((m) => m.t === 'error')
    expect(error.code).toBe('UNAUTHORIZED')
    expect(await socket.closed).toBe(4401)
  })

  it('refuses any other message before hello', async () => {
    const socket = await track(connect(url))
    socket.send({ t: 'sub', channels: [`ws:${ws}`] })

    const error = await socket.next<{ code: string; message: string }>((m) => m.t === 'error')
    expect(error.code).toBe('UNAUTHORIZED')
    expect(error.message).toContain('hello')
    expect(await socket.closed).toBe(4401)
  })

  it('answers ping with pong', async () => {
    const socket = await track(connectAs(url, alice))
    socket.send({ t: 'ping' })
    expect(await socket.next((m) => m.t === 'pong')).toBeTruthy()
  })
})

describe('subscription authorisation', () => {
  it('auto-subscribes the caller to their own user channel and their workspaces', async () => {
    const socket = await track(connectAs(url, alice))

    await chat.kernel.realtime.toUser(alice.id, {
      t: 'notification',
      notification: { id: 'n1', title: 'direct' },
    } as never)
    const direct = await socket.next<{ notification: { title: string }; seq: number }>(
      (m) => m.t === 'notification',
    )
    expect(direct.notification.title).toBe('direct')
    expect(direct.seq).toBeGreaterThan(0)

    await chat.kernel.realtime.change(ws, {
      module: 'chat',
      entity: 'channel',
      id: '01920000-0000-7000-8000-00000000d001',
      op: 'created',
    })
    const change = await socket.next<{ change: { entity: string } }>(
      (m) => m.t === 'change' && (m.change as { entity: string }).entity === 'channel',
    )
    expect(change.change.entity).toBe('channel')
  })

  it('refuses a workspace the caller does not belong to', async () => {
    const socket = await track(connectAs(url, alice))
    const foreign = chat.outsider('Mallory').principal.memberships[0]!.workspaceId

    socket.send({ t: 'sub', channels: [`ws:${foreign}`] })
    const error = await socket.next<{ code: string; message: string }>((m) => m.t === 'error')
    expect(error.code).toBe('FORBIDDEN')
    expect(error.message).toContain(foreign)

    // and nothing published there reaches the socket
    await chat.kernel.realtime.change(foreign, {
      module: 'chat',
      entity: 'channel',
      id: '01920000-0000-7000-8000-00000000d002',
      op: 'created',
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(socket.received.filter((m) => m.t === 'change')).toEqual([])
  })

  it('refuses a chat channel the caller is not a member of', async () => {
    const secret = await alice.api.channels.create({
      workspaceId: ws,
      name: name('secret'),
      type: 'private',
    })
    const socket = await track(connectAs(url, bob))

    socket.send({ t: 'sub', channels: [`chat:${secret.id}`] })
    const error = await socket.next<{ code: string }>((m) => m.t === 'error')
    expect(error.code).toBe('FORBIDDEN')
  })

  it('allows a public channel and streams its messages', async () => {
    const channel = await alice.api.channels.create({
      workspaceId: ws,
      name: name('public'),
      type: 'public',
    })
    const socket = await track(connectAs(url, bob))
    socket.send({ t: 'sub', channels: [`chat:${channel.id}`] })
    await new Promise((r) => setTimeout(r, 50))
    expect(socket.received.filter((m) => m.t === 'error')).toEqual([])

    const message = await alice.api.messages.post({
      workspaceId: ws,
      channelId: channel.id,
      body: doc('live update'),
    })
    const change = await socket.next<{ change: { id: string; patch: { bodyText: string } } }>(
      (m) => m.t === 'change' && (m.change as { entity: string }).entity === 'message',
    )
    expect(change.change.id).toBe(message.id)
    expect(change.change.patch.bodyText).toBe('live update')
  })

  it('stops delivering after unsub', async () => {
    const channel = await alice.api.channels.create({ workspaceId: ws, name: name('unsub'), type: 'public' })
    const socket = await track(connectAs(url, bob))
    socket.send({ t: 'sub', channels: [`chat:${channel.id}`] })
    await new Promise((r) => setTimeout(r, 50))
    await alice.api.messages.post({ workspaceId: ws, channelId: channel.id, body: doc('first') })
    await socket.next((m) => m.t === 'change')

    socket.send({ t: 'unsub', channels: [`chat:${channel.id}`] })
    await new Promise((r) => setTimeout(r, 50))
    const before = socket.received.length
    await alice.api.messages.post({ workspaceId: ws, channelId: channel.id, body: doc('second') })
    await new Promise((r) => setTimeout(r, 150))
    expect(socket.received.slice(before).filter((m) => m.t === 'change')).toEqual([])
  })
})

describe('typing', () => {
  it('fans out to the other subscribers and never echoes to the sender', async () => {
    const channel = await alice.api.channels.create({
      workspaceId: ws,
      name: name('typing'),
      type: 'public',
      memberIds: [bob.id],
    })
    const sender = await track(connectAs(url, alice))
    const watcher = await track(connectAs(url, bob))
    for (const s of [sender, watcher]) s.send({ t: 'sub', channels: [`chat:${channel.id}`] })
    await new Promise((r) => setTimeout(r, 50))

    sender.send({ t: 'typing', channelId: channel.id, workspaceId: ws })
    const seen = await watcher.next<{ userId: string; channelId: string; at: number }>(
      (m) => m.t === 'typing',
    )
    expect(seen.userId).toBe(alice.id)
    expect(seen.channelId).toBe(channel.id)
    expect(seen.at).toBeGreaterThan(0)
    expect(
      sender.received.filter((m) => m.t === 'typing'),
      'the sender must not see itself typing',
    ).toEqual([])
  })

  it('throttles repeated typing signals from the same socket', async () => {
    const channel = await alice.api.channels.create({
      workspaceId: ws,
      name: name('throttle'),
      type: 'public',
      memberIds: [bob.id],
    })
    const sender = await track(connectAs(url, alice))
    const watcher = await track(connectAs(url, bob))
    for (const s of [sender, watcher]) s.send({ t: 'sub', channels: [`chat:${channel.id}`] })
    await new Promise((r) => setTimeout(r, 50))

    for (let i = 0; i < 5; i++) sender.send({ t: 'typing', channelId: channel.id, workspaceId: ws })
    await watcher.next((m) => m.t === 'typing')
    await new Promise((r) => setTimeout(r, 150))
    expect(watcher.received.filter((m) => m.t === 'typing')).toHaveLength(1)
  })

  it('ignores typing in a channel the socket has not subscribed to', async () => {
    const channel = await alice.api.channels.create({
      workspaceId: ws,
      name: name('nosub'),
      type: 'public',
      memberIds: [bob.id],
    })
    const watcher = await track(connectAs(url, bob))
    watcher.send({ t: 'sub', channels: [`chat:${channel.id}`] })
    const sender = await track(connectAs(url, alice)) // never subscribes
    await new Promise((r) => setTimeout(r, 50))

    sender.send({ t: 'typing', channelId: channel.id, workspaceId: ws })
    await new Promise((r) => setTimeout(r, 150))
    expect(watcher.received.filter((m) => m.t === 'typing')).toEqual([])
  })
})

describe('presence', () => {
  it('announces a user coming online to their workspace and clears it when the last socket goes', async () => {
    const watcher = await track(connectAs(url, alice))
    const carol = chat.actor('Carol')

    const carolSocket = await track(connectAs(url, carol))
    const online = await watcher.next<{ userId: string; status: string }>(
      (m) => m.t === 'presence' && m.userId === carol.id,
    )
    expect(online.status).toBe('online')

    expect(
      await chat.kernel.call<Array<{ userId: string; status: string }>>('chat.presence.get', {
        userIds: [carol.id],
      }),
    ).toEqual([{ userId: carol.id, status: 'online', lastSeen: expect.any(Number) }])

    carolSocket.close()
    const offline = await watcher.next<{ status: string }>(
      (m) => m.t === 'presence' && m.userId === carol.id && m.status === 'offline',
    )
    expect(offline.status).toBe('offline')

    expect(
      await chat.kernel.call<Array<{ userId: string; status: string }>>('chat.presence.get', {
        userIds: [carol.id],
      }),
    ).toEqual([{ userId: carol.id, status: 'offline', lastSeen: null }])
  })

  it('keeps a user online while another of their tabs is still connected', async () => {
    const dave = chat.actor('Dave')
    const first = await track(connectAs(url, dave))
    const second = await track(connectAs(url, dave))

    first.close()
    await new Promise((r) => setTimeout(r, 150))
    const [entry] = await chat.kernel.call<Array<{ status: string }>>('chat.presence.get', {
      userIds: [dave.id],
    })
    expect(entry!.status).toBe('online')
    expect(second).toBeTruthy()
  })

  it('stores the status the client chose rather than flattening it to online', async () => {
    const erin = chat.actor('Erin')
    const socket = await track(connectAs(url, erin))
    socket.send({ t: 'presence', status: 'away' })
    await new Promise((r) => setTimeout(r, 150))

    const [entry] = await chat.kernel.call<Array<{ status: string }>>('chat.presence.get', {
      userIds: [erin.id],
    })
    expect(entry!.status).toBe('away')
  })
})

describe('metrics', () => {
  it('reports the sockets, users and subscriptions it is holding', async () => {
    const before = chat.service.gateway!.stats()
    const socket = await track(connectAs(url, bob))
    socket.send({ t: 'sub', channels: [`ws:${ws}`] })
    await new Promise((r) => setTimeout(r, 50))

    const after = chat.service.gateway!.stats()
    expect(after.sockets).toBeGreaterThan(before.sockets)
    expect(after.subscriptions).toBeGreaterThan(0)
  })
})
