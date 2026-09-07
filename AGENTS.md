# SlopBot agent guide

Read [`README.md`](README.md) first for the current architecture and local run commands. Treat live source as authoritative and [`docs/roadmap.md`](docs/roadmap.md) as planned work, not implemented behavior.

## Repository routes

| Path | Purpose | Read when |
|---|---|---|
| [`README.md`](README.md) | Architecture, setup, current capabilities, and repository layout | Every task |
| [`docs/roadmap.md`](docs/roadmap.md) | Status, acceptance criteria, invariants, and build order | Changing agents, messaging, memory, permissions, rooms, or scheduling |
| [`apps/web`](apps/web) | React UI, TanStack Router, chat, settings, and browser preview | Changing user-facing behavior |
| [`apps/server`](apps/server) | Hono host, oRPC boundary, environment parsing, and static UI serving | Changing APIs, configuration, or startup |
| [`packages/contracts`](packages/contracts) | Shared provider policy and computer request schemas | Changing provider choices or runtime/computer boundaries |
| [`packages/core`](packages/core) | Pi sessions, agent registry, SQLite mailroom, skills, and computer tools | Changing runtime or orchestration behavior |
| [`packages/browser-runtime/README.md`](packages/browser-runtime/README.md) | Browser service contract and Agent Infra parity scope | Changing Chromium, CDP, VNC, or browser endpoints |
| [`vm`](vm) | Lima computer VM, executor/desktop service, shared workspace | Changing local infrastructure or isolation |
| [`docs/computer-api.md`](docs/computer-api.md) | Harness-independent file, shell, browser, and desktop interface | Changing the connection between Pi and its computer |
| [`.env.example`](.env.example) | Supported project environment variables | Adding or changing configuration |

## Architecture invariants

- Run multiple persistent bots, each with a stable ID and private Pi session inside the SlopBot app process. Keep bot-to-bot handoffs durable, explicit, and visible in each transcript.
- Give every bot access to the same computer VM with its own X display and browser profile. Keep dashboard screenshots, computer input, and VNC scoped to that same bot-specific display.
- Run the SlopBot server, Pi runtime, shell/file tools, credentials, skills, database, sessions, bot workspace, browser, and desktops inside the Lima VM. The host CLI only manages the VM and connects to its forwarded interface.
- Keep runtime data on the VM disk. Deploy filtered source archives to `/opt/slopbot`; expose the selected host directory read-only at `/host` rather than using it as the bot workspace.
- Store bot configuration in SQLite and preserve Pi session history when configuration changes.
- Validate every HTTP, database, filesystem, and runtime boundary with the existing Zod schemas.
- Keep Hono and oRPC contracts end-to-end typed. Do not duplicate request types in the web app.
- Preserve unrelated work and do not commit credentials, browser profiles, databases, logs, or generated runtime state.

## Checks

Pi 0.85.0 imports `@earendil-works/pi-server` from its SDK import graph. Keep the matching direct dependency until upstream packages it; local leftover modules can hide a broken clean container install.

```sh
bun run check
bun run build
bun apps/server/src/verify.ts
bun run vm:up
limactl list
```

Update the matching document when an architectural boundary, capability status, environment variable, or browser contract changes.
