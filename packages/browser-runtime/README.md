# SlopBot browser runtime

A browser-only TypeScript service owned by SlopBot. It runs Chromium with a persistent profile, exposes the browser operations SlopBot uses, and provides an interactive noVNC login screen.

Agent Infra and SlopBot both use Chromium over Chrome DevTools Protocol (CDP). SlopBot uses Playwright Core as its TypeScript CDP client; Core does not bundle or download another browser.

## Parity reference

[Agent Infra Sandbox](https://github.com/agent-infra/sandbox) is the behavioral reference. SlopBot intentionally implements only this subset:

| Capability | SlopBot route |
|---|---|
| Browser readiness | `GET /v1/browser/info` |
| Raw CDP | Port `9222` |
| Screenshot | `GET /v1/browser/screenshot` |
| Navigate | `POST /v1/browser/page/navigate` |
| Visible text | `GET /v1/browser/page/text` |
| Click | `POST /v1/browser/page/click` |
| Fill | `POST /v1/browser/page/fill` |
| Evaluate | `POST /v1/browser/page/evaluate` |
| Scroll | `POST /v1/browser/page/scroll` |
| Key press | `POST /v1/browser/page/press_key` |
| Interactive login | `/vnc/vnc.html` |

Shell, files, VS Code, Jupyter, Python execution, terminal multiplexing, MCP, and unused browser endpoints remain outside this service. Pi already owns shell and filesystem tools in the SlopBot application container.
