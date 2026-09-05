# SlopBot

One persistent Pi bot connected to one Linux computer. By default, SlopBot runs natively on your Mac and connects to a separate Lima VM. Docker is optional. File and shell tools run on the host. Browser and desktop tools target the separate VM through its HTTP interface.

```text
Terminal / web UI → SlopBot runtime → computer API → Linux VM
                         │                                │
                 identity, history, auth          files, shell, desktop,
                                                   Chromium profile
```

## Run locally

Install on macOS from a checkout:

```sh
sh install.sh
slopbot
```

Or download the installer:

```sh
curl -fsSL https://raw.githubusercontent.com/simonbalfe/slopbot/main/install.sh | sh
```

The installer installs Bun if needed, builds the dashboard, and creates `~/.local/bin/slopbot`. Git is required. Remote installation defaults to `~/.local/share/slopbot`; override with `SLOPBOT_INSTALL_DIR`. Override the command directory with `SLOPBOT_BIN_DIR`. Existing destination directories are never overwritten. Lima is optional: install it with `brew install lima` for computer access.

This starts SlopBot natively and opens terminal chat. Run `bun run vm:up` when you want the separate computer available. Use `/login openai-codex` for OpenAI, or see [Nous Portal setup](docs/nous-portal.md) for subscription login and model selection.

| Command | Action |
|---|---|
| `bun run chat` | Start the native runtime and chat |
| `bun run chat:attach` | Attach without deploying changes |
| `bun run up` | Start the native runtime |
| `bun run runtime:up` | Start the native runtime |
| `bun run runtime:restart` | Restart the native runtime after code changes |
| `bun run runtime:stop` | Stop the native runtime |
| `bun run vm:up` | Start/update only the computer VM |
| `bun run vm:shell` | Enter the VM's terminal at `/workspace` |
| `bun run vm:stop` | Stop the computer; SlopBot keeps running |
| `bun run stop` | Stop both; retain their data |

Control the same desktop as the bot at <http://127.0.0.1:6080/vnc/vnc.html>. The optional chat UI is at <http://127.0.0.1:4317>. Right-click the desktop for apps, or run `DISPLAY=:99 xterm &` inside the VM shell.

Chat commands: `/clear`, `/config`, `/name TEXT`, `/role TEXT`, `/instructions TEXT`, `/computer` (also `/browser`), `/login`, and `/quit`. `/clear` clears the display without deleting history. Disconnecting leaves the services running.

The terminal interface provides a shaded composer, formatted Markdown responses, input history, and Shift+Enter for multiline messages. Headings, emphasis, code blocks, lists, links, and tables render inline as responses arrive. Startup output stays hidden; failures show the path to a diagnostic log.

## One computer connection

Pi does not require Docker or Lima. Any machine running SlopBot can connect to the computer's HTTP API. Configure `SLOPBOT_COMPUTER_URL` for remote browser and desktop access. `SLOPBOT_WORKSPACE` is the local host directory for file and shell tools; the macOS service defaults to `~/workspace`. The native runtime uses `http://127.0.0.1:6080`. macOS launchd keeps it running after you disconnect the terminal.

See the [computer interface](docs/computer-api.md) for configuration, request/response contracts, error behavior, and connecting another harness. Local file and shell tools work independently of VM availability. Remote browser and desktop operations fail explicitly if the VM is unreachable.

## Files and persistence

The VM has 2 CPUs, 3 GiB RAM, and a 20 GiB sparse disk under `~/.lima/slopbot`. It mounts `~/workspace` read/write at `/workspace`. To choose a different host folder, set `SLOPBOT_WORKSPACE_PATH` in the ignored project `.env` before creating the VM. Existing mounts can be changed with `limactl edit slopbot` while stopped.

| Location | Contents |
|---|---|
| Host `data/runtime/slopbot.sqlite` | Bot configuration and messages, stable bot ID `lead` |
| Host `data/runtime/pi` | Model authentication and Pi session history |
| VM `/data/browser` | Chromium profile and saved website logins |
| VM `/home/slopbot` | Persistent Linux home |
| VM `/workspace` | Shared work files; downloads go to `Downloads` |

SlopBot owns one state directory, `data/runtime`, configured through `SLOPBOT_DATA_DIR`. The engine-specific subdirectory is derived internally. The VM receives application source through a filtered deployment archive, not a repository mount. It does not need access to the runtime's credentials or database. Stopping or updating either component preserves its data.

Pi's detailed session format is still Pi-specific; full harness-independent bot-state storage is planned separately.

## Development

```sh
bun run dev
bun run check
bun run build
bun apps/server/src/verify.ts
```

The standalone verification uses temporary data and a simulated model response. It checks the tool relay, argument validation, disconnection behavior, bot configuration, session continuity, and terminal chat.

`bun run start:server` runs SlopBot in the foreground on any supported Bun host. Set `SLOPBOT_DATA_DIR` to a writable local directory, `SLOPBOT_WORKSPACE` to a local host working directory, and `SLOPBOT_COMPUTER_URL` to its API.

Docker remains optional via `bun run docker:up`. Stop the native runtime first and use `SLOPBOT_COMPUTER_URL=http://host.docker.internal:6080` for Docker on macOS. Both variants use the same state; never run them concurrently against it.

| Directory | Purpose |
|---|---|
| [apps/web](apps/web) | Optional chat and desktop preview |
| [apps/server](apps/server) | API host and terminal client |
| [packages/core](packages/core) | Bot configuration, queue, Pi sessions, host tools, remote computer access |
| [packages/browser-runtime](packages/browser-runtime/README.md) | Computer executor, desktop, Chromium |
| [vm](vm) | Local computer provisioning and lifecycle |

See the [roadmap](docs/roadmap.md) for planned work. An open-source license still needs to be selected.
