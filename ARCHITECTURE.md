# SlopBot architecture

```mermaid
flowchart TB
  Browser["Vite + React web UI<br/>TanStack Router + shadcn/ui"]

  subgraph Host["Docker host"]
    subgraph App["SlopBot container"]
      API["Hono + oRPC<br/>typed API"]
      Config["Zod environment config"]
      Controller["Agent controller"]
      Store[("SQLite<br/>agents, transcripts,<br/>message queue, sandbox assignments")]
      Runtime["Pi SDK<br/>in-process sessions + tools"]
      Codex["OpenAI Codex subscription"]

      subgraph Agents["Isolated Codex threads"]
        Lead["LEAD<br/>lead"]
        Worker["WORKER<br/>worker"]
      end

    end
    LeadSandbox["Agent Infra sandbox<br/>LEAD browser + VNC"]
    WorkerSandbox["Agent Infra sandbox<br/>WORKER browser + VNC"]
    Workspace[("Mounted workspace")]
  end

  Browser -->|"HTTP"| API
  Config --> API
  API --> Controller
  Controller <--> Store
  Controller <--> Runtime
  Runtime <--> Codex
  Runtime <--> Agents

  Agents -->|"send_to_agent"| Controller
  Controller -->|"durable envelope"| Store
  Store -->|"later hidden wake"| Controller

  Agents --> Workspace
  Controller -->|"Agent Infra TypeScript SDK"| LeadSandbox & WorkerSandbox
  LeadSandbox & WorkerSandbox --> Workspace
  LeadSandbox & WorkerSandbox -->|"separate human login"| Browser
```

## Implemented

- Stable `lead` and `worker` IDs with separate runtime sessions and transcripts.
- SQLite-backed message envelopes, delivery state, transcript events, and sandbox assignments.
- Fire-and-forget peer messaging through `send_to_agent`; replies arrive later as new durable messages.
- Skills and coding tools exposed by Pi.
- One Agent Infra browser sandbox per agent with a shared mounted workspace.
- SDK-backed browser navigation, selectors, page text, evaluation, screenshots, and user input.
- React, Vite, Tailwind, shadcn/ui, and TanStack Router web UI.
- Hono-hosted oRPC calls share the server router type directly with the web client.
- Environment variables are parsed once through the Zod schema in `packages/config`.

## Runtime boundary

SlopBot owns identity, persistence, messaging, agent scheduling, browser control, and permission boundaries. The runtime owns model turns and generic coding tools. This separation is deliberate: changing model providers cannot discard queued work or weaken host-side permissions.

## Runtime

Pi runs in-process and owns model sessions, ChatGPT subscription authentication, skill discovery, and generic shell/file tooling. SlopBot executes `send_to_agent` locally and routes the validated `browser` tool through the Agent Infra SDK.
