# Computer interface

An agent harness connects to one HTTP base URL. That computer owns the working filesystem, shell processes, Chromium profile, and desktop. The service runs no model or agent session and needs no model credentials.

SlopBot uses this API for browser and desktop control. Its standard file and shell tools run locally on the runtime host. The optional [remote-tools.ts](../packages/core/src/remote-tools.ts) adapter and executor endpoints remain available for other harnesses. JSON request/response schemas live in [computer.ts](../packages/contracts/src/computer.ts); browser operations are listed in the [desktop service reference](../packages/browser-runtime/README.md).

## Connect

| Setting | Meaning |
|---|---|
| `SLOPBOT_COMPUTER_URL` | Computer API address reachable from the Pi process |
| `SLOPBOT_COMPUTER_VIEW_URL` | Address reachable from the user's browser; defaults to the API address |
| `SLOPBOT_COMPUTER_API_KEY` | Optional shared key, matching the computer service's `SANDBOX_API_KEY` |
| `SLOPBOT_WORKSPACE` | Local SlopBot host workspace; independent of the VM working directory |

Locally, native SlopBot and your browser use `http://127.0.0.1:6080`. Optional Docker packaging uses `http://host.docker.internal:6080` for the API. For a remote VM, supply its reachable URL or a private tunnel address. Lima is only the local provisioner and is not part of the wire protocol.

When configured, send `X-AIO-API-Key` on every `/v1/*` request. The local service binds to loopback; VNC and CDP do not use this API key. Use a private connection for remote access.

## Shell and files

`GET /v1/tools` returns `{cwd, tools}`. Each tool has a `name`, `label`, `description`, and JSON Schema `parameters`. The seven tools are `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls`. The executor reuses Pi's tool implementations without starting a Pi model runtime.

`POST /v1/tools` executes one tool:

```json
{
  "id": "call-1",
  "name": "write",
  "input": {"path": "/workspace/example.txt", "content": "Hello"}
}
```

Read it with a subsequent request:

```json
{
  "id": "call-2",
  "name": "read",
  "input": {"path": "/workspace/example.txt"}
}
```

Responses contain `content`, an array of text or image blocks, plus optional `details`. Relative paths resolve against the computer's `cwd`; absolute paths refer to the computer, not the harness host. Shell exit failures and tool errors return HTTP errors. Invalid requests return HTTP 400.

Calls return their final result, with a five-minute execution ceiling. There is no output stream or execution lookup API yet. Cancellation is forwarded through the request signal. Request IDs identify calls but do not deduplicate them. The adapter never automatically retries a mutation: a disconnected request can have an unknown outcome, which the caller must inspect before retrying.

## Browser and desktop

The same base URL serves `/v1/browser/*` for page operations and `POST /v1/desktop` for full-screen screenshots, clicks, typing, keys, and scrolling. `{"action":"screenshot"}` returns a PNG. Other desktop operations return `{success, data}`.

The user controls the same display at `/vnc/vnc.html`. VNC is the interactive display transport; shell and file operations do not pass through VNC.

## State boundary

The computer retains work files and website logins. SlopBot keeps bot configuration, message records, model authentication, and Pi sessions outside the computer. Computer operations fail when the connection is unavailable; they never fall back to the harness host.

The computer API is harness-independent. Full bot-state portability is separate work: the SQLite records are accessible, but Pi's detailed session history is still Pi-specific.
