# Desktop runtime

The service runs Chromium, Openbox, and shell/file tool implementations inside SlopBot's Linux VM. Pi's model runtime runs separately and calls this service over HTTP. Follow the [local setup](../../README.md#run-locally) and [computer interface](../../docs/computer-api.md).

View the desktop at <http://127.0.0.1:6080/vnc/vnc.html>. Browser logins persist in `/data/browser`; downloads go to `/workspace/Downloads`. The service binds to guest localhost and Lima forwards the HTTP viewer and CDP port `9222` to host localhost.

## API

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Service health |
| GET | `/v1/tools` | Working directory and tool schemas |
| POST | `/v1/tools` | Execute one shell/file tool on this computer |
| POST | `/v1/desktop` | Screenshot, click, type, key, or scroll on the full desktop |
| GET | `/v1/browser/info` | Browser readiness, URL, and CDP address |
| GET | `/v1/browser/screenshot` | Browser page PNG |
| POST | `/v1/browser/page/navigate` | Open a URL |
| GET | `/v1/browser/page/text` | Read visible text |
| POST | `/v1/browser/page/click` | Click a selector or page coordinates |
| POST | `/v1/browser/page/fill` | Fill a field |
| POST | `/v1/browser/page/evaluate` | Run page JavaScript |
| POST | `/v1/browser/page/scroll` | Scroll the page |
| POST | `/v1/browser/page/press_key` | Press a browser key |

Desktop requests follow [desktop-protocol.ts](src/desktop-protocol.ts). Screenshots return PNG bytes; other operations return `{success, data}`. Coordinates use the 1280×1024 screen. Keys use X11 names such as `Return`, `ctrl+l`, and `alt+F2`. `type` inserts literal text. SlopBot's `computer` tool returns screenshots as images to Pi; its `browser` tool retains selector-based page operations.

`LISTEN_HOST` controls the bind address. If `SANDBOX_API_KEY` is set, `/v1/*` requires the matching `X-AIO-API-Key` header. This does not protect noVNC or raw CDP, which must remain private.
