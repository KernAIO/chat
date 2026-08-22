/**
 * Channel lifecycle: creating, browsing, joining, leaving, membership roles, and the DM rules —
 * a direct message is identified by its participant set, so opening the same conversation twice must
 * return the same channel rather than a second one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectRejection, startChat, type TestActor, type TestChat } from '../testing/harness.js'

let chat: TestChat
let alice: TestActor
let bob: TestActor
let carol: TestActor
let ws: string

let n = 0
const name = (prefix: string) => `${prefix}-${n++}-${Date.now().toString(36)}`

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

describe('creating channels', () => {
  it('makes the creator the owner and gives the channel a unique slug', async () => {
    const first = await alice.api.channels.create({ workspaceId: ws, name: 'Design', type: 'public' })
    expect(first.type).toBe('public')
    expect(first.name).toBe('Design')
    expect(first.slug).toBe('design')
    expect(first.membership?.role).toBe('owner')
    expect(first.memberCount).toBe(1)

    const second = await bob.api.channels.create({ workspaceId: ws, name: 'Design', type: 'public' })
    expect(second.slug).toBe('design-2')
  })

  it('adds the invited members up front', async () => {
    const channel = await alice.api.channels.create({
      workspaceId: ws,
      name: name('kickoff'),
      type: 'private',
      memberIds: [bob.id, carol.id],
    })
    expect(channel.memberCount).toBe(3)

    const members = await alice.api.channels.members.list({
      workspaceId: ws,
      channelId: channel.id,
      limit: 50,
    })
    expect(members.items.map((m) => m.userId).sort()).toEqual([alice.id, bob.id, carol.id].sort())
    expect(members.items.find((m) => m.userId === alice.id)?.role).toBe('owner')
    expect(members.items.find((m) => m.userId === bob.id)?.role).toBe('member')
  })

  it('posts a system message announcing the channel', async () => {
    const channel = await alice.api.channels.create({ workspaceId: ws, name: name('news'), type: 'public' })
    const messages = await alice.api.messages.list({ workspaceId: ws, channelId: channel.id, limit: 10 })
    expect(messages.items).toHaveLength(1)
    expect(messages.items[0]!.kind).toBe('system')
    expect(messages.items[0]!.metadata.event).toBe('created')
    // system messages must not move anybody's unread counter
    const unread = await alice.api.channels.unread({ workspaceId: ws })
    expect(unread.channels.find((c) => c.channelId === channel.id)?.unreadCount).toBe(0)
  })

  it('rejects names that would collide with mention syntax', async () => {
    await expect(
      alice.api.channels.create({ workspaceId: ws, name: '#nope', type: 'public' }),
    ).rejects.toThrow()
  })
})

describe('browsing, joining and leaving', () => {
  it('lists public channels with the caller’s join state and hides private ones', async () => {
    const open = await alice.api.channels.create({ workspaceId: ws, name: name('open'), type: 'public' })
    const secret = await alice.api.channels.create({ workspaceId: ws, name: name('secret'), type: 'private' })

    const browsed = await bob.api.channels.browse({ workspaceId: ws, limit: 100 })
    const ids = browsed.items.map((c) => c.id)
    expect(ids).toContain(open.id)
    expect(ids).not.toContain(secret.id)
    expect(browsed.items.find((c) => c.id === open.id)?.joined).toBe(false)

    await bob.api.channels.join({ workspaceId: ws, channelId: open.id })
    const after = await bob.api.channels.browse({ workspaceId: ws, limit: 100 })
    expect(after.items.find((c) => c.id === open.id)?.joined).toBe(true)

    const mine = await bob.api.channels.list({ workspaceId: ws })
    expect(mine.items.map((c) => c.id)).toContain(open.id)
  })

  it('refuses to join a private channel and hides it from non-members', async () => {
    const secret = await alice.api.channels.create({ workspaceId: ws, name: name('vault'), type: 'private' })
    await expectRejection(() => bob.api.channels.join({ workspaceId: ws, channelId: secret.id }), 'NOT_FOUND')
    await expectRejection(() => bob.api.channels.get({ workspaceId: ws, channelId: secret.id }), 'NOT_FOUND')
  })

  it('lets a member leave, and promotes somebody when the last owner walks out', async () => {
    const channel = await alice.api.channels.create({
      workspaceId: ws,
      name: name('handover'),
      type: 'private',
      memberIds: [bob.id],
    })
    await alice.api.channels.leave({ workspaceId: ws, channelId: channel.id })

    const members = await bob.api.channels.members.list({
      workspaceId: ws,
      channelId: channel.id,
      limit: 10,
    })
    expect(members.items.map((m) => m.userId)).toEqual([bob.id])
    expect(members.items[0]!.role, 'the remaining member inherits the channel').toBe('owner')
  })

  it('only lets a manager add members to a private channel', async () => {
    const channel = await alice.api.channels.create({
      workspaceId: ws,
      name: name('closed'),
      type: 'private',
      memberIds: [bob.id],
    })
    await expectRejection(
      () => bob.api.channels.members.add({ workspaceId: ws, channelId: channel.id, userIds: [carol.id] }),
      'FORBIDDEN',
    )

    const { added } = await alice.api.channels.members.add({
      workspaceId: ws,
      channelId: channel.id,
      userIds: [carol.id],
    })
    expect(added).toEqual([carol.id])

    // adding somebody twice is a no-op rather than an error
    const again = await alice.api.channels.members.add({
      workspaceId: ws,
      channelId: channel.id,
      userIds: [carol.id],
    })
    expect(again.added).toEqual([])
  })

  it('lets a manager promote a member and the promoted member then manages too', async () => {
    const channel = await alice.api.channels.create({
      workspaceId: ws,
      name: name('promote'),
      type: 'private',
      memberIds: [bob.id, carol.id],
    })
    const promoted = await alice.api.channels.members.setRole({
      workspaceId: ws,
      channelId: channel.id,
      userId: bob.id,
      role: 'admin',
    })
    expect(promoted.role).toBe('admin')

    await bob.api.channels.members.remove({ workspaceId: ws, channelId: channel.id, userId: carol.id })
    const members = await alice.api.channels.members.list({
      workspaceId: ws,
      channelId: channel.id,
      limit: 10,
    })
    expect(members.items.map((m) => m.userId).sort()).toEqual([alice.id, bob.id].sort())
  })
})

describe('archiving', () => {
  it('archives a channel, blocks posting and hides it from the default listing', async () => {
    const channel = await alice.api.channels.create({
      workspaceId: ws,
      name: name('sunset'),
      type: 'public',
      memberIds: [bob.id],
    })
    const archived = await alice.api.channels.archive({ workspaceId: ws, channelId: channel.id })
    expect(archived.archivedAt).not.toBeNull()

    await expectRejection(
      () =>
        alice.api.messages.post({
          workspaceId: ws,
          channelId: channel.id,
          body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
        }),
      'CONFLICT',
    )
    await expectRejection(
      () => carol.api.channels.join({ workspaceId: ws, channelId: channel.id }),
      'CONFLICT',
    )

    expect((await alice.api.channels.list({ workspaceId: ws })).items.map((c) => c.id)).not.toContain(
      channel.id,
    )
    expect(
      (await alice.api.channels.list({ workspaceId: ws, includeArchived: true })).items.map((c) => c.id),
    ).toContain(channel.id)

    // and it can be brought back
    const restored = await alice.api.channels.archive({
      workspaceId: ws,
      channelId: channel.id,
      archived: false,
    })
    expect(restored.archivedAt).toBeNull()
  })

  it('refuses to archive a direct message even for somebody who could archive a channel', async () => {
    const wsAdmin = chat.actor('Chief', { role: 'admin' })
    const dm = await wsAdmin.api.channels.openDm({ workspaceId: ws, userId: bob.id })
    await expectRejection(
      () => wsAdmin.api.channels.archive({ workspaceId: ws, channelId: dm.id }),
      'BAD_REQUEST',
    )
    // and a plain member is stopped one step earlier, by the permission itself
    await expectRejection(() => bob.api.channels.archive({ workspaceId: ws, channelId: dm.id }), 'FORBIDDEN')
  })

  it('only lets a channel owner (or a workspace admin) archive', async () => {
    const channel = await alice.api.channels.create({
      workspaceId: ws,
      name: name('guarded'),
      type: 'public',
      memberIds: [bob.id],
    })
    await expectRejection(
      () => bob.api.channels.archive({ workspaceId: ws, channelId: channel.id }),
      'FORBIDDEN',
    )

    const wsAdmin = chat.actor('Boss', { role: 'admin' })
    await wsAdmin.api.channels.join({ workspaceId: ws, channelId: channel.id })
    await expect(
      wsAdmin.api.channels.archive({ workspaceId: ws, channelId: channel.id }),
    ).resolves.toBeTruthy()
  })
})

describe('direct messages', () => {
  it('returns the same channel however the pair opens it', async () => {
    const fromAlice = await alice.api.channels.openDm({ workspaceId: ws, userId: bob.id })
    const again = await alice.api.channels.openDm({ workspaceId: ws, userId: bob.id })
    const fromBob = await bob.api.channels.openDm({ workspaceId: ws, userId: alice.id })

    expect(again.id).toBe(fromAlice.id)
    expect(fromBob.id, 'the participant set identifies the DM, not who opened it').toBe(fromAlice.id)
    expect(fromAlice.type).toBe('dm')
    expect(fromAlice.name).toBeNull()
    expect([...fromAlice.dmUserIds].sort()).toEqual([alice.id, bob.id].sort())
  })

  it('dedupes group DMs by participant set regardless of order', async () => {
    const dave = chat.actor('Dave')
    const first = await alice.api.channels.createGroupDm({ workspaceId: ws, userIds: [bob.id, dave.id] })
    const second = await bob.api.channels.createGroupDm({ workspaceId: ws, userIds: [dave.id, alice.id] })

    expect(second.id).toBe(first.id)
    expect(first.type).toBe('group_dm')
    expect([...first.dmUserIds].sort()).toEqual([alice.id, bob.id, dave.id].sort())
  })

  it('collapses a two-person "group" DM into the plain DM', async () => {
    const dm = await alice.api.channels.openDm({ workspaceId: ws, userId: carol.id })
    const group = await alice.api.channels.createGroupDm({ workspaceId: ws, userIds: [carol.id, alice.id] })
    expect(group.id).toBe(dm.id)
    expect(group.type).toBe('dm')
  })

  it('defaults DM membership to notify-on-everything', async () => {
    const dm = await alice.api.channels.openDm({ workspaceId: ws, userId: bob.id })
    expect(dm.membership?.notifyLevel).toBe('all')
  })

  it('refuses to remove a participant from a DM', async () => {
    const dm = await alice.api.channels.openDm({ workspaceId: ws, userId: bob.id })
    await expectRejection(
      () => alice.api.channels.leave({ workspaceId: ws, channelId: dm.id }),
      'BAD_REQUEST',
    )
  })
})

describe('object channels', () => {
  it('gets-or-creates one channel per object and adds the requested members', async () => {
    const objectRef = { module: 'tracker', type: 'issue', id: '01920000-0000-7000-8000-00000000f001' }
    const first = await alice.api.channels.ensureObjectChannel({
      workspaceId: ws,
      objectRef,
      name: 'KRN-1 Fix the thing',
      memberIds: [bob.id],
    })
    expect(first.type).toBe('object')
    expect(first.objectRef).toEqual(objectRef)

    const second = await bob.api.channels.ensureObjectChannel({
      workspaceId: ws,
      objectRef,
      name: 'KRN-1 Fix the thing',
      memberIds: [carol.id],
    })
    expect(second.id).toBe(first.id)

    const members = await alice.api.channels.members.list({ workspaceId: ws, channelId: first.id, limit: 20 })
    expect(members.items.map((m) => m.userId).sort()).toEqual([alice.id, bob.id, carol.id].sort())
  })

  it('is reachable by other modules through kernel.call', async () => {
    const objectRef = { module: 'tracker', type: 'issue', id: '01920000-0000-7000-8000-00000000f002' }
    const channel = await chat.kernel.call<{ id: string; type: string }>(
      'chat.channels.ensureObjectChannel',
      {
        workspaceId: ws,
        objectRef,
        name: 'KRN-2',
        memberIds: [alice.id],
      },
    )
    expect(channel.type).toBe('object')

    const posted = await chat.kernel.call<{ kind: string; bodyText: string }>('chat.messages.postSystem', {
      workspaceId: ws,
      channelId: channel.id,
      actorId: alice.id,
      event: 'status_changed',
      text: 'moved the issue to In Progress',
      data: {},
    })
    expect(posted.kind).toBe('system')
    expect(posted.bodyText).toBe('moved the issue to In Progress')
  })
})

describe('personal organisation', () => {
  it('remembers favourites and sidebar sections per user', async () => {
    const channel = await alice.api.channels.create({ workspaceId: ws, name: name('fav'), type: 'public' })
    await alice.api.channels.favorite({ workspaceId: ws, channelId: channel.id, favorite: true })

    const section = await alice.api.sections.create({ workspaceId: ws, name: 'Projects' })
    await alice.api.sections.setChannel({ workspaceId: ws, channelId: channel.id, sectionId: section.id })

    const mine = await alice.api.channels.list({ workspaceId: ws })
    const view = mine.items.find((c) => c.id === channel.id)
    expect(view?.favorite).toBe(true)
    expect(view?.sectionId).toBe(section.id)
    expect(mine.sections.find((s) => s.id === section.id)?.channelIds).toEqual([channel.id])

    // another member sees the same channel without Alice's personal organisation
    await bob.api.channels.join({ workspaceId: ws, channelId: channel.id })
    const theirs = await bob.api.channels.list({ workspaceId: ws })
    const theirView = theirs.items.find((c) => c.id === channel.id)
    expect(theirView?.favorite).toBe(false)
    expect(theirView?.sectionId).toBeNull()
  })

  it('mutes a channel for one member only', async () => {
    const channel = await alice.api.channels.create({
      workspaceId: ws,
      name: name('noisy'),
      type: 'public',
      memberIds: [bob.id],
    })
    const membership = await bob.api.channels.updateMembership({
      workspaceId: ws,
      channelId: channel.id,
      muted: true,
      notifyLevel: 'none',
    })
    expect(membership.muted).toBe(true)
    expect(membership.notifyLevel).toBe('none')

    const mine = await alice.api.channels.list({ workspaceId: ws })
    expect(mine.items.find((c) => c.id === channel.id)?.membership?.muted).toBe(false)
  })
})

describe('workspace boundaries', () => {
  it('refuses a caller who is not a member of the workspace', async () => {
    const outsider = chat.outsider('Mallory')
    await expectRejection(() => outsider.api.channels.list({ workspaceId: ws }), 'FORBIDDEN')

    const channel = await alice.api.channels.create({ workspaceId: ws, name: name('inside'), type: 'public' })
    await expectRejection(
      () => outsider.api.channels.get({ workspaceId: ws, channelId: channel.id }),
      'FORBIDDEN',
    )
  })

  it('refuses when the chat module is disabled for the workspace', async () => {
    const disabled = await startChat({
      procedures: { 'core.modules.isEnabled': () => false },
    })
    try {
      const someone = disabled.actor('Nobody')
      await expectRejection(
        () => someone.api.channels.list({ workspaceId: disabled.workspaceId }),
        'MODULE_DISABLED',
      )
    } finally {
      await disabled.stop()
    }
  })
})

describe('workspace lifecycle events', () => {
  it('bootstraps #general and #random and auto-joins new members', async () => {
    const fresh = await startChat()
    try {
      const founder = fresh.actor('Founder')
      const joiner = fresh.actor('Joiner')

      await fresh.kernel.events.publishRaw({
        id: '01920000-0000-7000-8000-00000000e001',
        name: 'core.workspace.created',
        version: 1,
        module: 'core',
        workspaceId: fresh.workspaceId as never,
        actorId: founder.id as never,
        occurredAt: new Date().toISOString(),
        payload: { workspaceId: fresh.workspaceId, createdBy: founder.id },
      })

      const browsed = await founder.api.channels.browse({ workspaceId: fresh.workspaceId, limit: 20 })
      expect(browsed.items.map((c) => c.slug).sort()).toEqual(['general', 'random'])
      expect(browsed.items.every((c) => c.autoJoin)).toBe(true)

      await fresh.kernel.events.publishRaw({
        id: '01920000-0000-7000-8000-00000000e002',
        name: 'core.member.joined',
        version: 1,
        module: 'core',
        workspaceId: fresh.workspaceId as never,
        actorId: joiner.id as never,
        occurredAt: new Date().toISOString(),
        payload: { workspaceId: fresh.workspaceId, userId: joiner.id },
      })
      const mine = await joiner.api.channels.list({ workspaceId: fresh.workspaceId })
      expect(mine.items.map((c) => c.slug).sort()).toEqual(['general', 'random'])

      await fresh.kernel.events.publishRaw({
        id: '01920000-0000-7000-8000-00000000e003',
        name: 'core.member.removed',
        version: 1,
        module: 'core',
        workspaceId: fresh.workspaceId as never,
        actorId: null,
        occurredAt: new Date().toISOString(),
        payload: { workspaceId: fresh.workspaceId, userId: joiner.id },
      })
      expect((await joiner.api.channels.list({ workspaceId: fresh.workspaceId })).items).toEqual([])
    } finally {
      await fresh.stop()
    }
  })
})
