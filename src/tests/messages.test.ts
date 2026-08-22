/**
 * Posting and reading messages: sequence numbers, the unread and mention counters every member
 * carries, threads, reactions, and who gets notified (and who deliberately does not).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { doc, expectRejection, startChat, type TestActor, type TestChat } from '../testing/harness.js'

let chat: TestChat
let alice: TestActor
let bob: TestActor
let carol: TestActor
let ws: string

let n = 0
const name = (prefix: string) => `${prefix}-${n++}-${Date.now().toString(36)}`

/** A public channel with the three actors in it. */
async function channel(prefix = 'room') {
  const c = await alice.api.channels.create({
    workspaceId: ws,
    name: name(prefix),
    type: 'public',
    memberIds: [bob.id, carol.id],
  })
  return c.id
}

const unreadOf = async (actor: TestActor, channelId: string) => {
  const summary = await actor.api.channels.unread({ workspaceId: ws })
  return summary.channels.find((c) => c.channelId === channelId)
}

beforeAll(async () => {
  chat = await startChat()
  ws = chat.workspaceId
  alice = chat.actor('Alice')
  bob = chat.actor('Bob')
  carol = chat.actor('Carol')
})
afterAll(async () => {
  await chat?.stop()
})

describe('posting', () => {
  it('assigns a per-channel sequence that increments by one', async () => {
    const a = await channel('seq')
    const b = await channel('seq')

    const first = await alice.api.messages.post({ workspaceId: ws, channelId: a, body: doc('one') })
    const second = await bob.api.messages.post({ workspaceId: ws, channelId: a, body: doc('two') })
    const other = await alice.api.messages.post({ workspaceId: ws, channelId: b, body: doc('elsewhere') })

    expect(second.seq).toBe(first.seq + 1)
    // sequences are per channel, not global
    expect(other.seq).toBeLessThan(second.seq)

    const view = await alice.api.channels.get({ workspaceId: ws, channelId: a })
    expect(view.lastSeq).toBe(second.seq)
    expect(view.lastMessageAt).not.toBeNull()
  })

  it('stores the plain-text rendering and the extracted mentions', async () => {
    const id = await channel('render')
    const message = await alice.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('ship it ', { users: [bob.id] }),
    })
    expect(message.bodyText).toContain('ship it')
    expect(message.mentions.users).toEqual([bob.id])
    expect(message.mentions.channel).toBe(false)
    expect(message.kind).toBe('user')
    expect(message.authorId).toBe(alice.id)
  })

  it('refuses an empty message and a non-member', async () => {
    const id = await channel('guard')
    await expectRejection(
      () => alice.api.messages.post({ workspaceId: ws, channelId: id, body: { type: 'doc', content: [] } }),
      'BAD_REQUEST',
    )

    const dave = chat.actor('Dave')
    await expectRejection(
      () => dave.api.messages.post({ workspaceId: ws, channelId: id, body: doc('let me in') }),
      'FORBIDDEN',
    )
  })

  it('lists messages newest-last and pages backwards by seq', async () => {
    const id = await channel('paging')
    const posted = []
    for (let i = 0; i < 5; i++)
      posted.push(await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc(`m${i}`) }))

    const page = await alice.api.messages.list({ workspaceId: ws, channelId: id, limit: 3 })
    expect(page.items.map((m) => m.bodyText)).toEqual(['m2', 'm3', 'm4'])
    expect(page.hasMoreBefore).toBe(true)

    const older = await alice.api.messages.list({
      workspaceId: ws,
      channelId: id,
      before: page.items[0]!.seq,
      limit: 10,
    })
    // the channel-created system message sits at the very front
    expect(older.items.map((m) => m.bodyText)).toEqual(['created the channel', 'm0', 'm1'])
    expect(older.hasMoreBefore).toBe(false)
    expect(posted).toHaveLength(5)
  })
})

describe('unread and mention counters', () => {
  it('moves for everyone except the author', async () => {
    const id = await channel('counters')
    await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('hello all') })

    expect((await unreadOf(alice, id))?.unreadCount, 'the author is already caught up').toBe(0)
    expect((await unreadOf(bob, id))?.unreadCount).toBe(1)
    expect((await unreadOf(carol, id))?.unreadCount).toBe(1)
    expect((await unreadOf(bob, id))?.mentionCount).toBe(0)

    await bob.api.messages.post({ workspaceId: ws, channelId: id, body: doc('hi back') })
    expect((await unreadOf(alice, id))?.unreadCount).toBe(1)
    // posting does not mark the channel read: Bob still owes Alice's earlier message a read
    expect((await unreadOf(bob, id))?.unreadCount).toBe(1)
    expect((await unreadOf(carol, id))?.unreadCount).toBe(2)
  })

  it('counts a direct mention as a mention for that member only', async () => {
    const id = await channel('mention')
    await alice.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('over to you ', { users: [bob.id] }),
    })

    expect((await unreadOf(bob, id))?.mentionCount).toBe(1)
    expect((await unreadOf(carol, id))?.mentionCount).toBe(0)
    expect((await unreadOf(carol, id))?.unreadCount).toBe(1)
  })

  it('counts @channel as a mention for every member but the author', async () => {
    const id = await channel('atchannel')
    await alice.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('heads up', { channel: true }),
    })

    expect((await unreadOf(bob, id))?.mentionCount).toBe(1)
    expect((await unreadOf(carol, id))?.mentionCount).toBe(1)
    expect((await unreadOf(alice, id))?.mentionCount).toBe(0)
  })

  it('resets on markRead and recomputes from the read position', async () => {
    const id = await channel('markread')
    await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('one') })
    const second = await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('two') })
    await alice.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('three ', { users: [bob.id] }),
    })
    expect((await unreadOf(bob, id))?.unreadCount).toBe(3)

    // reading up to the second message leaves exactly the third unread
    const partial = await bob.api.channels.markRead({ workspaceId: ws, channelId: id, messageId: second.id })
    expect(partial.lastReadSeq).toBe(second.seq)
    expect(partial.unreadCount).toBe(1)
    expect(partial.mentionCount).toBe(1)

    const all = await bob.api.channels.markRead({ workspaceId: ws, channelId: id })
    expect(all.unreadCount).toBe(0)
    expect(all.mentionCount).toBe(0)
    expect(all.lastReadAt).not.toBeNull()
  })

  it('starts new members caught up rather than with a wall of unread', async () => {
    const id = await channel('latecomer')
    for (let i = 0; i < 3; i++)
      await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc(`old ${i}`) })

    const dave = chat.actor('Dave')
    await dave.api.channels.join({ workspaceId: ws, channelId: id })
    expect((await unreadOf(dave, id))?.unreadCount).toBe(0)

    await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('new') })
    expect((await unreadOf(dave, id))?.unreadCount).toBe(1)
  })

  it('keeps muted channels out of the workspace totals', async () => {
    const loud = await channel('loud')
    const quiet = await channel('quiet')
    await bob.api.channels.updateMembership({ workspaceId: ws, channelId: quiet, muted: true })

    await alice.api.messages.post({ workspaceId: ws, channelId: loud, body: doc('ping') })
    await alice.api.messages.post({ workspaceId: ws, channelId: quiet, body: doc('ping') })

    const summary = await bob.api.channels.unread({ workspaceId: ws })
    expect(summary.channels.find((c) => c.channelId === quiet)?.muted).toBe(true)
    expect(summary.channels.find((c) => c.channelId === quiet)?.unreadCount).toBe(1)
    expect(summary.channels.find((c) => c.channelId === loud)?.unreadCount).toBe(1)
    // the badge the user actually sees is the sum over the channels they did not mute
    const audible = summary.channels.filter((c) => !c.muted).reduce((sum, c) => sum + c.unreadCount, 0)
    expect(summary.totals.unread).toBe(audible)
  })

  it('gives an unread message back when it is deleted before being read', async () => {
    const id = await channel('undelete')
    const message = await alice.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('oops ', { users: [bob.id] }),
    })
    expect((await unreadOf(bob, id))?.unreadCount).toBe(1)
    expect((await unreadOf(bob, id))?.mentionCount).toBe(1)

    await alice.api.messages.delete({ workspaceId: ws, messageId: message.id })
    expect((await unreadOf(bob, id))?.unreadCount).toBe(0)
    expect((await unreadOf(bob, id))?.mentionCount).toBe(0)
  })
})

describe('threads', () => {
  it('attaches replies to the root and keeps them out of the channel timeline', async () => {
    const id = await channel('thread')
    const root = await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('question?') })
    const reply = await bob.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('answer'),
      threadRootId: root.id,
    })
    expect(reply.threadRootId).toBe(root.id)

    const timeline = await alice.api.messages.list({ workspaceId: ws, channelId: id, limit: 50 })
    expect(timeline.items.map((m) => m.id)).not.toContain(reply.id)
    expect(timeline.items.find((m) => m.id === root.id)?.replyCount).toBe(1)

    const thread = await alice.api.messages.thread({ workspaceId: ws, messageId: root.id })
    expect(thread.root.id).toBe(root.id)
    expect(thread.replies.map((m) => m.id)).toEqual([reply.id])
    expect([...thread.participants].sort()).toEqual([alice.id, bob.id].sort())
  })

  it('flattens a reply to a reply onto the same root', async () => {
    const id = await channel('flatten')
    const root = await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('root') })
    const first = await bob.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('first'),
      threadRootId: root.id,
    })
    const second = await carol.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('second'),
      threadRootId: first.id,
    })
    expect(second.threadRootId).toBe(root.id)

    const thread = await alice.api.messages.thread({ workspaceId: ws, messageId: root.id })
    expect(thread.replies.map((m) => m.id)).toEqual([first.id, second.id])
    expect(thread.root.replyCount).toBe(2)
  })

  it('does not raise the channel unread count for a plain thread reply', async () => {
    const id = await channel('quietthread')
    const root = await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('root') })
    await carol.api.channels.markRead({ workspaceId: ws, channelId: id })
    expect((await unreadOf(carol, id))?.unreadCount).toBe(0)

    await bob.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('just a reply'),
      threadRootId: root.id,
    })
    expect((await unreadOf(carol, id))?.unreadCount).toBe(0)

    // ...but a mention inside the thread still counts
    await bob.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('what do you think ', { users: [carol.id] }),
      threadRootId: root.id,
    })
    expect((await unreadOf(carol, id))?.mentionCount).toBe(1)
  })

  it('shows a broadcast reply in the channel timeline and counts it as unread', async () => {
    const id = await channel('broadcast')
    const root = await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('root') })
    await carol.api.channels.markRead({ workspaceId: ws, channelId: id })

    const shout = await bob.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('also sending to channel'),
      threadRootId: root.id,
      broadcast: true,
    })
    const timeline = await alice.api.messages.list({ workspaceId: ws, channelId: id, limit: 50 })
    expect(timeline.items.map((m) => m.id)).toContain(shout.id)
    expect((await unreadOf(carol, id))?.unreadCount).toBe(1)
  })

  it('refuses a thread root from another channel', async () => {
    const a = await channel('rootA')
    const b = await channel('rootB')
    const root = await alice.api.messages.post({ workspaceId: ws, channelId: a, body: doc('root') })
    await expectRejection(
      () =>
        alice.api.messages.post({
          workspaceId: ws,
          channelId: b,
          body: doc('reply'),
          threadRootId: root.id,
        }),
      'BAD_REQUEST',
    )
  })
})

describe('editing, deleting, reactions and pins', () => {
  it('edits only your own message unless you can manage the channel', async () => {
    const id = await channel('edit')
    const message = await bob.api.messages.post({ workspaceId: ws, channelId: id, body: doc('typo') })

    const edited = await bob.api.messages.edit({
      workspaceId: ws,
      messageId: message.id,
      body: doc('fixed'),
    })
    expect(edited.bodyText).toBe('fixed')
    expect(edited.editedAt).not.toBeNull()

    await expectRejection(
      () => carol.api.messages.edit({ workspaceId: ws, messageId: message.id, body: doc('sabotage') }),
      'FORBIDDEN',
    )
    // the channel owner may
    await expect(
      alice.api.messages.edit({ workspaceId: ws, messageId: message.id, body: doc('moderated') }),
    ).resolves.toBeTruthy()
  })

  it('tombstones a deleted message instead of dropping the row', async () => {
    const id = await channel('delete')
    const message = await bob.api.messages.post({ workspaceId: ws, channelId: id, body: doc('regrettable') })
    await bob.api.messages.delete({ workspaceId: ws, messageId: message.id })

    const fetched = await alice.api.messages.get({ workspaceId: ws, messageId: message.id })
    expect(fetched.deletedAt).not.toBeNull()
    expect(fetched.bodyText).toBe('')
    expect(fetched.body).toEqual({ type: 'doc', content: [] })

    // deleting twice is idempotent
    await expect(bob.api.messages.delete({ workspaceId: ws, messageId: message.id })).resolves.toEqual({
      ok: true,
    })
    await expectRejection(
      () => bob.api.messages.edit({ workspaceId: ws, messageId: message.id, body: doc('undo') }),
      'CONFLICT',
    )
  })

  it('toggles reactions and aggregates them per emoji', async () => {
    const id = await channel('react')
    const message = await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('ship it') })

    const first = await bob.api.messages.react({ workspaceId: ws, messageId: message.id, emoji: '🎉' })
    expect(first.added).toBe(true)
    expect(first.reactions).toEqual([{ emoji: '🎉', count: 1, userIds: [bob.id] }])

    const second = await carol.api.messages.react({ workspaceId: ws, messageId: message.id, emoji: '🎉' })
    expect(second.reactions[0]!.count).toBe(2)
    expect([...second.reactions[0]!.userIds].sort()).toEqual([bob.id, carol.id].sort())

    const off = await bob.api.messages.react({ workspaceId: ws, messageId: message.id, emoji: '🎉' })
    expect(off.added).toBe(false)
    expect(off.reactions).toEqual([{ emoji: '🎉', count: 1, userIds: [carol.id] }])

    // reactions come back with the message
    const fetched = await alice.api.messages.get({ workspaceId: ws, messageId: message.id })
    expect(fetched.reactions).toEqual([{ emoji: '🎉', count: 1, userIds: [carol.id] }])
  })

  it('pins and unpins', async () => {
    const id = await channel('pin')
    const message = await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('read this') })

    const pinned = await alice.api.messages.pin({ workspaceId: ws, messageId: message.id, pinned: true })
    expect(pinned.pinned).toBe(true)
    expect((await bob.api.messages.pins({ workspaceId: ws, channelId: id })).map((m) => m.id)).toEqual([
      message.id,
    ])

    await alice.api.messages.pin({ workspaceId: ws, messageId: message.id, pinned: false })
    expect(await bob.api.messages.pins({ workspaceId: ws, channelId: id })).toEqual([])
  })

  it('bookmarks a message for one user only', async () => {
    const id = await channel('bookmark')
    const message = await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('keep me') })
    await bob.api.messages.bookmark({ workspaceId: ws, messageId: message.id, bookmarked: true })

    expect((await bob.api.messages.bookmarks({ workspaceId: ws, limit: 20 })).items.map((m) => m.id)).toEqual(
      [message.id],
    )
    expect((await carol.api.messages.bookmarks({ workspaceId: ws, limit: 20 })).items).toEqual([])
  })
})

describe('search', () => {
  it('finds messages in channels the caller can read and skips the ones they cannot', async () => {
    const open = await alice.api.channels.create({ workspaceId: ws, name: name('open'), type: 'public' })
    const closed = await alice.api.channels.create({ workspaceId: ws, name: name('closed'), type: 'private' })
    await alice.api.messages.post({
      workspaceId: ws,
      channelId: open.id,
      body: doc('the palladium report is ready'),
    })
    await alice.api.messages.post({
      workspaceId: ws,
      channelId: closed.id,
      body: doc('the palladium budget is secret'),
    })

    const mine = await alice.api.messages.search({ workspaceId: ws, q: 'palladium', limit: 20 })
    expect(mine.items).toHaveLength(2)

    const theirs = await carol.api.messages.search({ workspaceId: ws, q: 'palladium', limit: 20 })
    expect(theirs.items.map((m) => m.channel.id)).toEqual([open.id])
  })

  it('skips deleted messages', async () => {
    const id = await channel('searchdel')
    const message = await alice.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('ephemeral rhodium note'),
    })
    expect(
      (await alice.api.messages.search({ workspaceId: ws, q: 'rhodium', limit: 10 })).items,
    ).toHaveLength(1)
    await alice.api.messages.delete({ workspaceId: ws, messageId: message.id })
    expect((await alice.api.messages.search({ workspaceId: ws, q: 'rhodium', limit: 10 })).items).toEqual([])
  })
})

describe('notifications and indexing', () => {
  const since = () => chat.notifications.length

  it('notifies mentioned members and nobody else', async () => {
    const id = await channel('notify')
    const at = since()
    await alice.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('please look ', { users: [bob.id] }),
    })

    const sent = chat.notifications.slice(at)
    expect(sent.map((x) => x.userId)).toEqual([bob.id])
    expect(sent[0]!.type).toBe('chat.mention')
    expect(sent[0]!.actorId).toBe(alice.id)
    expect(String(sent[0]!.title)).toContain('Alice')
  })

  it('never notifies the author of their own message', async () => {
    const id = await channel('selfnotify')
    const at = since()
    await alice.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('talking to myself ', { users: [alice.id] }),
    })
    expect(chat.notifications.slice(at).map((x) => x.userId)).toEqual([])
  })

  it('skips muted members for @channel but still reaches a direct mention', async () => {
    const id = await channel('mute')
    await bob.api.channels.updateMembership({ workspaceId: ws, channelId: id, muted: true })

    let at = since()
    await alice.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('all hands', { channel: true }),
    })
    expect(
      chat.notifications.slice(at).map((x) => x.userId),
      '@channel respects mute',
    ).toEqual([carol.id])

    at = since()
    await alice.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('you specifically ', { users: [bob.id] }),
    })
    expect(
      chat.notifications.slice(at).map((x) => x.userId),
      'a direct mention bypasses mute',
    ).toEqual([bob.id])
  })

  it('respects notifyLevel none entirely and all for every message', async () => {
    const id = await channel('levels')
    await bob.api.channels.updateMembership({ workspaceId: ws, channelId: id, notifyLevel: 'none' })
    await carol.api.channels.updateMembership({ workspaceId: ws, channelId: id, notifyLevel: 'all' })

    const at = since()
    await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('anybody there?') })
    const sent = chat.notifications.slice(at)
    expect(sent.map((x) => x.userId)).toEqual([carol.id])
    expect(sent[0]!.type).toBe('chat.channel_message')
  })

  it('notifies both participants of a direct message', async () => {
    const dm = await alice.api.channels.openDm({ workspaceId: ws, userId: bob.id })
    const at = since()
    await alice.api.messages.post({ workspaceId: ws, channelId: dm.id, body: doc('coffee?') })

    const sent = chat.notifications.slice(at)
    expect(sent.map((x) => x.userId)).toEqual([bob.id])
    expect(sent[0]!.type).toBe('chat.dm')
  })

  it('notifies thread participants of a reply', async () => {
    const id = await channel('threadnotify')
    const root = await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('root') })
    await bob.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('first reply'),
      threadRootId: root.id,
    })

    const at = since()
    await bob.api.messages.post({
      workspaceId: ws,
      channelId: id,
      body: doc('second reply'),
      threadRootId: root.id,
    })
    const sent = chat.notifications.slice(at)
    expect(sent.map((x) => x.userId)).toEqual([alice.id])
    expect(sent[0]!.type).toBe('chat.thread_reply')
  })

  it('indexes the message into core search with the channel members as its acl', async () => {
    const open = await alice.api.channels.create({ workspaceId: ws, name: name('idx'), type: 'public' })
    const priv = await alice.api.channels.create({
      workspaceId: ws,
      name: name('idxpriv'),
      type: 'private',
      memberIds: [bob.id],
    })

    const publicMessage = await alice.api.messages.post({
      workspaceId: ws,
      channelId: open.id,
      body: doc('indexable message'),
    })
    const privateMessage = await alice.api.messages.post({
      workspaceId: ws,
      channelId: priv.id,
      body: doc('restricted message'),
    })

    const byId = new Map(
      chat.indexed.map((d) => [(d.object as { id: string }).id, d as Record<string, unknown>]),
    )
    const pub = byId.get(publicMessage.id)
    expect(pub, 'the message should have been handed to core.search.index').toBeDefined()
    expect(pub!.body).toBe('indexable message')
    expect(pub!.acl, 'public channels are visible workspace-wide').toBeNull()
    expect(pub!.workspaceId).toBe(ws)

    const secret = byId.get(privateMessage.id)
    expect(secret).toBeDefined()
    expect([...(secret!.acl as string[])].sort()).toEqual([alice.id, bob.id].sort())
  })

  it('removes a deleted message from the core index', async () => {
    const id = await channel('unindex')
    const message = await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('temporary') })
    const at = chat.calls.length
    await alice.api.messages.delete({ workspaceId: ws, messageId: message.id })

    const removal = chat.calls.slice(at).find((c) => c.name === 'core.search.remove')
    expect(removal, 'deleting a message should ask core to drop it from the index').toBeDefined()
    const refs = (removal!.input as { refs?: Array<{ object: { id: string } }> }).refs
    expect(refs?.map((r) => r.object.id)).toEqual([message.id])
  })

  it('records channel activity for the audit log', async () => {
    const id = await channel('activity')
    const at = chat.calls.length
    await alice.api.messages.post({ workspaceId: ws, channelId: id, body: doc('audit me') })

    const recorded = chat.calls.slice(at).find((c) => c.name === 'core.activity.record')
    expect(recorded).toBeDefined()
    expect((recorded!.input as { action: string }).action).toBe('message_posted')
  })
})

describe('slash commands', () => {
  it('posts /me and /shrug, mutes with /mute and rejects the unknown', async () => {
    const id = await channel('commands')

    const shrug = await alice.api.commands.run({
      workspaceId: ws,
      channelId: id,
      command: 'shrug',
      text: 'ok',
    })
    expect(shrug.handled).toBe(true)
    expect(shrug.message?.bodyText).toContain('¯\\_(ツ)_/¯')

    const me = await alice.api.commands.run({ workspaceId: ws, channelId: id, command: '/me', text: 'waves' })
    expect(me.message?.bodyText).toBe('waves')
    expect(me.message?.metadata.me).toBe(true)

    const muted = await bob.api.commands.run({ workspaceId: ws, channelId: id, command: 'mute', text: '' })
    expect(muted.ephemeral).toBe('Channel muted.')
    expect((await unreadOf(bob, id))?.muted).toBe(true)

    const unknown = await alice.api.commands.run({ workspaceId: ws, channelId: id, command: 'teleport' })
    expect(unknown).toEqual({ handled: false, ephemeral: 'Unknown command /teleport', message: null })
  })
})
