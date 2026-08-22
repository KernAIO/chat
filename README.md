# Kern chat service

Hosts the [chat module](https://github.com/KernALO/modules) and the **realtime WebSocket gateway** that
every Kern module shares. Part of [Kern](https://github.com/KernALO/kern).

```
browser ──ws──▶ /ws  gateway ──▶ chat module ──▶ Postgres (mod_chat)
                    ▲                    │
   other services ──┘ NATS kern.rt.*     └─ core (notifications, search, users) via kernel.call
```

## Realtime protocol

Clients speak the protocol defined in `@kernalo/contracts` (`ClientMessage` / `ServerMessage`).

| client → server | meaning |
|---|---|
| `hello` | authenticate with a session token (required within 10s, else the socket closes with 4401) |
| `sub` / `unsub` | subscribe to channels; every subscription is authorised |
| `typing` | typing indicator, throttled per user and channel, never echoed to the sender |
| `presence` | set presence; refreshed by pings and stored in Valkey with a TTL |
| `ping` | keep-alive, answered with `pong` |

| server → client | meaning |
|---|---|
| `welcome` | authentication succeeded |
| `change` | an entity was created, updated or deleted (drives cache invalidation) |
| `notification` / `badge` | a new notification, and unread counts per workspace |
| `typing` / `presence` | other members' activity |
| `error` | subscription refused or message rejected |

Channel names: `user:<userId>` (private, auto-subscribed), `ws:<workspaceId>` (everything in a
workspace), `ws:<workspaceId>:<module>:<id>` (one object), `chat:<channelId>` (a chat channel).

## Scaling

Sockets are sticky to one replica but hold no shared state. Services publish through
`kernel.realtime`, which fans out over NATS (`kern.rt.ch.*`, `kern.rt.user.*`); each replica forwards
only what its own sockets subscribe to, and publishes made in-process are delivered without a round
trip. Presence lives in Valkey with a TTL, so it survives a replica restart and expires on its own if
a socket disappears without a clean close.

## Development

```bash
pnpm dev                      # http://localhost:4100 (health at /api/health, metrics at /api/chat/metrics)
KERN_TOKEN=<token> pnpm smoke  # connect a WebSocket client and print the traffic
```

Requires the core service for identity (`core.users.principal`) plus Postgres, NATS and Valkey —
`pnpm infra` in the umbrella repo starts them.
