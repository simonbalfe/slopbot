# SlopBot

An open-source take on Grok Bot: a local app where AI agents chat with you, delegate work to each other, browse the web, and work on files.

SlopBot is an independent project inspired by the Grok Bot agent blueprint. The current implementation uses OpenAI Codex through Pi; Grok model support is not implemented.

## What it does

- Create and delete bots in Settings, each with its own role and private chat history.
- Give a bot a task and let it hand work to another bot through persistent messages.
- Watch an assigned browser live, interact with it, and sign in to websites.
- Let agents read and edit files or run commands in a shared workspace.
- Create reusable skills in Settings and attach a skill to a message.
- Keep agent profiles, chat history, and message delivery state across restarts.

For example, ask one bot to research a task and hand the implementation to another. The bots exchange explicit messages; their private conversations stay separate.

## Run locally

You need Docker with Compose and a ChatGPT account with Codex access.

The checked-in Compose file includes a local Leads CLI integration. For a standalone setup, remove these two entries from the `slopbot.volumes` list in [compose.yaml](compose.yaml):

```yaml
- ./data/bin/leads:/usr/local/bin/leads:ro
- ${CODEX_HOME}/skills/gmaps-leads-cli:/data/pi/skills/gmaps-leads-cli:ro
```

Then run from the repository root:

```sh
docker compose up -d --build
```

Open <http://127.0.0.1:4317> and follow the Codex sign-in prompt. Start with the default **lead** and **worker** bots, or create your own in Settings. Use **Open login** to sign in to a bot's assigned browser.

Files are shared through `./workspace` by default. To use another folder, set `SLOPBOT_WORKSPACE_PATH` before starting Compose:

```sh
export SLOPBOT_WORKSPACE_PATH=/absolute/path/to/your/project
docker compose up -d --build
```

App data and authentication are stored in `./data`. Browser logins are stored in Docker volumes. See [.env.example](.env.example) for configuration names.

### Optional Leads CLI

To keep the Leads integration, set `CODEX_HOME` to your Codex directory containing `skills/gmaps-leads-cli`, and `REPOS_ROOT` to the repository root containing `projects/clients/david/gmaps-leads-cli`. With Bun installed, run `bun run install:leads` before starting Compose. Set `LEADS_API_URL` to your Leads API server; provider credentials stay on that server.

## How it works

The React web app talks to a Hono server through a typed oRPC API. Pi runs each bot as a separate session in one app process. SQLite stores profiles, visible transcripts, and queued messages; Pi persists its own sessions.

Compose starts the app and two browser containers. Browser slots are assigned when available, independently of the number of bots. Each slot has its own persistent login profile. All bots share the workspace and app container.

This is an early local prototype. Tool actions currently run without an approval prompt. Keep the app, browser views, and raw browser-control ports private. Scoped memory, approval controls, cancellation, group rooms, and additional model providers are planned in the [roadmap](docs/roadmap.md).

## Development

Install Bun, complete the Compose setup above, then run:

```sh
bun install
bun run dev
```

The UI runs at <http://127.0.0.1:5175> and proxies requests to the Docker app at port `4317`.

```sh
bun run check
bun test
bun run build
```

`bun start` builds and runs the app directly on the host. It does not start browser containers; agents use the host filesystem and available shell tools.

| Directory | Purpose |
|---|---|
| [apps/web](apps/web) | Chat, settings, and browser preview |
| [apps/server](apps/server) | API, configuration, and web app serving |
| [packages/core](packages/core) | Agent sessions, messaging, persistence, and tools |
| [packages/browser-runtime](packages/browser-runtime/README.md) | Chromium service and browser API |

## License

An open-source license still needs to be selected and added to this repository.
