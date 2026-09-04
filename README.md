# OpenBot

OpenBot is a minimal two-agent desktop app. LEAD coordinates work, WORKER executes it, and every handoff is a durable message rather than shared chat context.

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

The current model runtime is Codex App Server. Pi was selected as the replacement runtime but has not yet been wired in. The migration changes only the model and tool-call adapter: OpenBot's agent registry, SQLite queue, browser CDP tool, local-computer approval boundary, and UI remain host-owned.

The package currently exports the Codex transport and orchestration layers separately:

```ts
import { AgentController, CodexAppServer } from "openbot";

const cwd = process.cwd();
const client = new CodexAppServer({ cwd });
const agents = new AgentController(client, {
  cwd,
  databasePath: ".openbot/openbot.sqlite",
});

await agents.initialize();
agents.sendMessage("lead", "Research this, build it, then review it.");
```

Agent profiles, runtime session IDs, message envelopes, delivery states, and visible transcripts persist in SQLite.

Open `http://127.0.0.1:4317` for the local UI.

## Shared cloud computer

`compose.yaml` runs one Linux computer with one Xvfb server and two X11 screens. LEAD and WORKER each keep a stable screen, browser profile, runtime session, and noVNC URL while sharing `/workspace`. Agents control only their own browser through a private Chromium CDP endpoint. noVNC is the live viewer and human-login surface.

```sh
docker compose up -d --build
docker exec -it openbot codex login --device-auth
```

The Compose ports bind only to the Hetzner host's Tailscale address. Start Electron with `OPENBOT_SERVER_URL=http://100.68.65.17:4317 bun start` to use the cloud computer.

Electron also exposes a read-only companion on the Mac's Tailscale address. Agents can request one file read or directory listing at a time. Every request shows a native macOS approval dialog, stays within the user's home directory, and is limited to 64 KiB for files and 200 entries for directories.

## Runtime migration

The next implementation step is a `PiRuntime` adapter using Pi's SDK in-process. It will replace `CodexAppServer` without spawning the Pi CLI. Pi will supply session execution, model authentication, provider routing, shell and file tools, and custom-tool callbacks. The host retains the durable coordination state and routes `send_to_agent`, `browser_cdp`, and local-computer calls through its existing validated handlers.
