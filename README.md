# OpenBot

Minimal multi-agent controller built on Codex App Server.

```sh
bun install
bun start
```

The package exports the transport and orchestration layers separately:

```ts
import { AgentController, CodexAppServer } from "openbot";

const cwd = process.cwd();
const client = new CodexAppServer({ cwd });
const agents = new AgentController(client, cwd);

await agents.initialize();
agents.sendMessage("lead", "Research this, build it, then review it.");
```

Open `http://127.0.0.1:4317` for the local UI.
