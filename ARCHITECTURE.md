# SlopBot architecture

```mermaid
flowchart TB
  subgraph Mac["Your Mac"]
    Electron["SlopBot Electron UI"]
    Companion["Read-only local companion"]
    Approval["Native Allow once / Deny prompt"]
    Home[("User home directory")]
  end

  subgraph Host["Docker host"]
    subgraph Docker["SlopBot Docker container"]
      API["Bun HTTP API"]
      Controller["Agent controller"]
      LocalClient["Local computer client"]
      Store[("SQLite<br/>agents, transcripts,<br/>message queue, screen assignments")]
      Runtime["Pi SDK<br/>in-process sessions + tools"]
      Codex["OpenAI Codex subscription"]

      subgraph Agents["Isolated Codex threads"]
        Lead["LEAD<br/>lead"]
        Worker["WORKER<br/>worker"]
      end

      subgraph Computer["One shared virtual computer"]
        Workspace[("Shared /workspace")]
        Xvfb["One Xvfb server<br/>:99"]
        S0["Screen :99.0<br/>LEAD"]
        S1["Screen :99.1<br/>WORKER"]
        Browsers["Openbox + persistent Chromium<br/>one profile per agent"]
        CDP["Private CDP endpoints<br/>127.0.0.1:9222 and :9223"]
        VNC["x11vnc + noVNC<br/>ports 6080 and 6081"]
      end
    end
  end

  Electron -->|"HTTP"| API
  Controller --> LocalClient
  LocalClient -->|"typed read request over Tailscale"| Companion
  Companion --> Approval
  Approval -->|"Allow once"| Home
  API --> Controller
  Controller <--> Store
  Controller <--> Runtime
  Runtime <--> Codex
  Runtime <--> Agents

  Agents -->|"send_to_agent"| Controller
  Controller -->|"durable envelope"| Store
  Store -->|"later hidden wake"| Controller

  Agents --> Workspace
  Controller --> Xvfb
  Xvfb --> S0 & S1
  S0 & S1 --> Browsers
  Agents -->|"browser_cdp"| CDP
  CDP --> Browsers
  Browsers --> VNC
  VNC -->|"human browser login"| Electron
```

## Implemented

- Stable `lead` and `worker` IDs with separate runtime sessions and transcripts.
- SQLite-backed message envelopes, delivery state, transcript events, and X11 screen assignments.
- Fire-and-forget peer messaging through `send_to_agent`; replies arrive later as new durable messages.
- Skills and coding tools exposed by Pi.
- One shared Linux computer with two X11 screens, a shared workspace, and one persistent Chromium profile per agent.
- Private CDP browser control and Electron live-screen preview with user input forwarding.
- Approval-gated read-only access to the user's Mac through a separate local companion.
- React, Vite, and Tailwind Electron renderer. Chat bubbles are content-sized and Markdown is safely rendered by a small local renderer.

## Runtime boundary

SlopBot owns identity, persistence, messaging, agent scheduling, browser control, and permission boundaries. The runtime owns model turns and generic coding tools. This separation is deliberate: changing model providers cannot discard queued work or weaken host-side permissions.

## Runtime

Pi runs in-process and owns model sessions, ChatGPT subscription authentication, skill discovery, and generic shell/file tooling. SlopBot continues to execute `send_to_agent`, `browser_cdp`, `local_read_file`, and `local_list_directory` through its validated host handlers.
