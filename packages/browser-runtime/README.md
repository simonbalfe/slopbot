# Browser runtime

SlopBot's browser service runs Chromium with a persistent login profile. Agents use its HTTP API to browse, and users can watch or sign in through noVNC.

The root [Compose file](../../compose.yaml) starts two browser slots. Follow the [local setup](../../README.md#run-locally) to run them with the app.

## Local access

| Slot | Browser view | Raw CDP |
|---|---|---|
| 1 | <http://127.0.0.1:6080/vnc/vnc.html> | Port `9222` |
| 2 | <http://127.0.0.1:6081/vnc/vnc.html> | Port `9223` |

Each slot keeps its login profile in a separate Docker volume. Both mount the shared workspace at `/workspace`; downloads go to `/workspace/Downloads`.

## API

Routes are relative to the slot's HTTP address, such as `http://127.0.0.1:6080`.

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Service health |
| GET | `/v1/browser/info` | Browser readiness, current URL, and CDP address |
| GET | `/v1/browser/screenshot` | PNG screenshot |
| POST | `/v1/browser/page/navigate` | Open a URL |
| GET | `/v1/browser/page/text` | Read visible text |
| POST | `/v1/browser/page/click` | Click a selector or coordinates |
| POST | `/v1/browser/page/fill` | Fill a field |
| POST | `/v1/browser/page/evaluate` | Run page JavaScript |
| POST | `/v1/browser/page/scroll` | Scroll the page |
| POST | `/v1/browser/page/press_key` | Press a key |

When `SANDBOX_API_KEY` is set, `/v1/*` requests require the matching `X-AIO-API-Key` header. Compose passes this key from `SLOPBOT_SANDBOX_API_KEY`. This does not protect noVNC or raw CDP; keep those ports private.

## Implementation

The service uses TypeScript, Hono, and Playwright Core to control system Chromium over the Chrome DevTools Protocol (CDP). Xvfb, x11vnc, and noVNC provide the interactive view.

Agent Infra Sandbox is a browser API reference. This service implements only the browser operations SlopBot uses. Agent sessions, shell commands, and file tools run in the SlopBot app container.
