# SlopBot agent guide

Read [`README.md`](README.md) first for the current architecture and local run commands. Treat live source as authoritative and [`docs/roadmap.md`](docs/roadmap.md) as planned work, not implemented behavior.

## Repository routes

| Path | Purpose | Read when |
|---|---|---|
| [`README.md`](README.md) | Architecture, setup, current capabilities, and repository layout | Every task |
| [`docs/roadmap.md`](docs/roadmap.md) | Status, acceptance criteria, invariants, and build order | Changing agents, messaging, memory, permissions, rooms, or scheduling |
| [`apps/web`](apps/web) | React UI, TanStack Router, chat, settings, and browser preview | Changing user-facing behavior |
| [`apps/server`](apps/server) | Hono host, oRPC boundary, environment parsing, and static UI serving | Changing APIs, configuration, or startup |
| [`packages/core`](packages/core) | Pi sessions, agent registry, SQLite mailroom, skills, and computer tools | Changing runtime or orchestration behavior |
| [`packages/browser-runtime/README.md`](packages/browser-runtime/README.md) | Browser service contract and Agent Infra parity scope | Changing Chromium, CDP, VNC, or browser endpoints |
| [`vm`](vm) | Lima computer VM, executor/desktop service, shared workspace | Changing local infrastructure or isolation |
| [`docs/computer-api.md`](docs/computer-api.md) | Harness-independent file, shell, browser, and desktop interface | Changing the connection between Pi and its computer |
| [`.env.example`](.env.example) | Supported project environment variables | Adding or changing configuration |

## Architecture invariants

- Run one active bot (stable ID `lead`) in one Pi session inside the SlopBot app process. Keep extra stored bots inactive.
- SlopBot runs natively outside the computer by default; Compose is optional packaging. Its shell/file tools run on the runtime host; browser and desktop tools target the separate VM. Lima runs the computer executor and desktop only.
- Keep runtime credentials and database outside the computer. Never mount the runtime repository or data into the VM; deploy filtered source archives.
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
