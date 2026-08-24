<p align="center">
<img src="https://raw.githubusercontent.com/KernAIO/kern/main/assets/kern-mark.svg" width="56" alt="">
</p>

# chat

**Conversations, and the connection that keeps the whole application live.**

[![CI](https://img.shields.io/github/actions/workflow/status/KernAIO/chat/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/KernAIO/chat/actions/workflows/ci.yml)
[![Licence](https://img.shields.io/badge/licence-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-pre--1.0-orange?style=flat-square)](https://github.com/KernAIO/kern#what-works-today)
[![Last commit](https://img.shields.io/github/last-commit/KernAIO/chat?style=flat-square)](https://github.com/KernAIO/chat/commits/main)
[![Website](https://img.shields.io/badge/kernaio.com-1f2328?style=flat-square)](https://kernaio.com)

Two jobs in one service. It holds the messages: channels, direct messages, group messages, threads,
reactions, pinned messages and read state. It also holds the websocket that every
[Kern](https://github.com/KernAIO/kern) client keeps open.

That second job is why chat runs on its own. One person has one connection, whatever they are
looking at. A new message arrives on it, and so does an issue changing under someone else's cursor,
a notification, a typing indicator and a presence change.

## Run it

Goal: start chat on your own machine and open a websocket to it.

You need:

- Node 24 and pnpm 10.
- A Postgres 18 database.
- Valkey, if you want presence stored rather than skipped.

Most people should run the whole platform from the
[umbrella repository](https://github.com/KernAIO/kern) instead. There, `pnpm setup && pnpm infra &&
pnpm dev` starts chat with everything it talks to.

### 1. Install and configure

```bash
pnpm install
cp .env.example .env
```

Set `DATABASE_URL` in `.env` to your Postgres database.

### 2. Start chat

```bash
pnpm dev
```

The service creates its own database tables the first time it starts.

**Expected result:** `migrations applied`, then `chat service listening` on port 4100.

## What it exposes

| Path | What answers there |
|---|---|
| `/api/chat/*` | Channels, messages, threads, reactions, pins, search |
| `/ws` | The websocket every client keeps open |

## How the websocket works

A client connects to `/ws` and subscribes to named channels:

| Channel name | Carries |
|---|---|
| `ws:<workspaceId>` | Everything that changed in a workspace |
| `ws:<workspaceId>:<module>:<id>` | One object, while somebody has it open |
| `chat:<channelId>` | Messages and typing in one conversation |
| `user:<userId>` | Notifications and unread counts — subscribed automatically |

Messages travel between service instances over NATS, so it does not matter which instance a person
is connected to.

## Things worth knowing

- **The browser cannot read the session cookie**, because it is `HttpOnly`. The gateway therefore
  reads the cookie from the upgrade request itself. A client that cannot send a token still connects.
- **Presence needs Valkey.** Without it, presence is skipped rather than faked.
- **Read state is per member, not per message.** Each membership stores the last sequence number it
  read, which is what makes an unread count one number instead of a scan.
- A workspace that switches chat off keeps its messages. Nothing is deleted; the module stops
  answering.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md).

## Licence

[AGPL-3.0-only](LICENSE). This repository is part of the Kern product.
The Kern framework you build modules against is Apache-2.0 — see
[LICENSING.md](https://github.com/KernAIO/kern/blob/main/LICENSING.md).

---

**Kern** — one place for your team's work: issues, conversations, documents and people.
Open source, self-hosted. [kernaio.com](https://kernaio.com) · [github.com/KernAIO](https://github.com/KernAIO)
