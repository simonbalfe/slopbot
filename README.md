# SlopBot

SlopBot is a minimal two-agent desktop app. LEAD coordinates work, WORKER executes it, and every handoff is a durable message rather than shared chat context.

```sh
bun install
bun start
```

`bun start` builds the React and Tailwind UI, then opens Electron. For a browser-only server, build first and run `bun run start:server`.

```sh
bun run build:web
bun run start:server
```

## Current status

- Electron desktop UI built with React, Vite, and Tailwind.
- Two stable agents: `lead` and `worker`.
- Separate durable transcripts and a SQLite message queue.
- Asynchronous `send_to_agent` handoffs with visible sender and recipient records.
- Per-agent Chromium profiles on one shared X11 computer, controlled through private CDP endpoints.
- A live browser preview in Electron with direct pointer and scroll input.
- Skills are listed in Settings and attached to a run only when selected.
- Read-only Mac file and directory access is approval-gated by the local companion.

The model runtime is Pi's in-process SDK using the `openai-codex` provider and a ChatGPT Plus or Pro subscription. SlopBot's agent registry, SQLite queue, browser CDP tool, local-computer approval boundary, and UI remain host-owned.

The core package exports the Pi runtime and SlopBot orchestration layers separately:

```ts
import { AgentController, PiRuntime } from "slopbot";

const cwd = process.cwd();
const runtime = new PiRuntime({ cwd });
const agents = new AgentController(runtime, {
  cwd,
  databasePath: ".slopbot/slopbot.sqlite",
});

await agents.initialize();
agents.sendMessage("lead", "Research this, build it, then review it.");
```

Agent profiles, runtime session IDs, message envelopes, delivery states, and visible transcripts persist in SQLite.

Open `http://127.0.0.1:4317` for the local UI.

## Local Docker computer

`compose.yaml` runs one Linux computer with one Xvfb server and two X11 screens. LEAD and WORKER each keep a stable screen, browser profile, runtime session, and noVNC URL while sharing `/workspace`. Agents control only their own browser through a private Chromium CDP endpoint. noVNC is the live viewer and human-login surface.

```sh
docker compose up -d --build
docker compose run --rm --entrypoint /app/packages/core/node_modules/.bin/pi slopbot
```

In Pi, run `/login` and choose ChatGPT Plus/Pro (Codex). The OAuth tokens are stored under the existing `data` volume and refreshed by Pi.

Open `http://127.0.0.1:4317`. LEAD and WORKER are viewable at `http://127.0.0.1:6080/vnc.html` and `http://127.0.0.1:6081/vnc.html`.

For a cloud host, copy `.env.example` to `.env`, set `SLOPBOT_BIND_ADDRESS` to the host's private network address and `SLOPBOT_X11_VIEWER_BASE_URL` to its reachable URL, then run the same command.

Electron also exposes a read-only companion on the Mac's Tailscale address. Agents can request one file read or directory listing at a time. Every request shows a native macOS approval dialog, stays within the user's home directory, and is limited to 64 KiB for files and 200 entries for directories.

## Repository layout

- `apps/desktop`: Electron shell and approval-gated Mac companion.
- `apps/server`: Bun API and static UI host.
- `apps/web`: React, Vite, and Tailwind renderer.
- `packages/core`: Pi runtime adapter, orchestration, persistence, and computer tools.
