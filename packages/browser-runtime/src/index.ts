import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout } from "node:timers/promises";

import { Hono } from "hono";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { z } from "zod";
import { ComputerArgumentsSchema } from "./desktop-protocol.ts";
import { toolRelay } from "./tool-relay.ts";

const EnvSchema = z.object({
  BROWSER_PROFILE_DIR: z.string().min(1).default("/data/browser"),
  BROWSER_WORKSPACE: z.string().min(1).default("/workspace"),
  BROWSER_CDP_PORT: z.coerce.number().int().min(1).max(65_535).default(9222),
  BROWSER_CDP_PROXY_PORT: z.coerce.number().int().min(1).max(65_535).default(9322),
  BROWSER_CDP_PUBLIC_URL: z.url().default("http://127.0.0.1:9222"),
  DISPLAY: z.string().min(1).default(":99"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  LISTEN_HOST: z.string().min(1).default("0.0.0.0"),
  SANDBOX_API_KEY: z.string().optional(),
});
const PointSchema = z.number().finite().min(0).max(16_384);
const NavigateSchema = z.object({ url: z.url() });
const ClickSchema = z
  .object({
    selector: z.string().min(1).optional(),
    x: PointSchema.optional(),
    y: PointSchema.optional(),
    button: z.enum(["left", "middle", "right"]).default("left"),
    click_count: z.number().int().min(1).max(2).default(1),
  })
  .refine(({ selector, x, y }) => Boolean(selector || (x !== undefined && y !== undefined)), {
    message: "selector or coordinates are required",
  });
const FillSchema = z.object({ selector: z.string().min(1), text: z.string() });
const EvaluateSchema = z.object({ expression: z.string().min(1) });
const ScrollSchema = z.object({
  direction: z.enum(["up", "down", "left", "right"]),
  amount: z.number().finite().nonnegative(),
});
const KeySchema = z.object({ key: z.string().min(1).max(100) });

const env = EnvSchema.parse(process.env);
process.env["DISPLAY"] = env.DISPLAY;

for (const lockFile of ["SingletonCookie", "SingletonLock", "SingletonSocket"])
  rmSync(join(env.BROWSER_PROFILE_DIR, lockFile), { force: true });
mkdirSync(join(env.BROWSER_WORKSPACE, "Downloads"), { recursive: true });

const processes = [
  Bun.spawn(["Xvfb", env.DISPLAY, "-screen", "0", "1280x1024x24", "-ac", "-nolisten", "tcp"]),
];
await setTimeout(500);
processes.push(
  Bun.spawn(["openbox"]),
  Bun.spawn(["x11vnc", "-display", env.DISPLAY, "-rfbport", "5900", "-localhost", "-forever", "-shared", "-nopw"]),
);

const context = await chromium.launchPersistentContext(env.BROWSER_PROFILE_DIR, {
  executablePath: "/usr/bin/chromium",
  headless: false,
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
  chromiumSandbox: process.getuid?.() !== 0,
  args: [
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,1024",
    `--remote-debugging-port=${env.BROWSER_CDP_PORT}`,
  ],
  acceptDownloads: true,
  downloadsPath: join(env.BROWSER_WORKSPACE, "Downloads"),
  viewport: null,
});
processes.push(Bun.spawn(["xterm", "-geometry", "88x24+20+40", "-title", "SlopBot VM"], { cwd: env.BROWSER_WORKSPACE }));

async function page(): Promise<Page> {
  return context.pages().find((candidate) => !candidate.isClosed()) ?? context.newPage();
}

const cdpPeers = new WeakMap<Bun.Socket, Bun.Socket>();
function closePeer(socket: Bun.Socket): void {
  const peer = cdpPeers.get(socket);
  cdpPeers.delete(socket);
  if (peer) {
    cdpPeers.delete(peer);
    peer.end();
  }
}
const cdpProxy = Bun.listen({
  hostname: env.LISTEN_HOST,
  port: env.BROWSER_CDP_PROXY_PORT,
  socket: {
    open(client) {
      client.pause();
      void Bun.connect({
        hostname: "127.0.0.1",
        port: env.BROWSER_CDP_PORT,
        socket: {
          open(upstream) {
            cdpPeers.set(client, upstream);
            cdpPeers.set(upstream, client);
            client.resume();
          },
          data(upstream, data) {
            cdpPeers.get(upstream)?.write(data);
          },
          close: closePeer,
          error: closePeer,
        },
      }).catch(() => client.end());
    },
    data(client, data) {
      cdpPeers.get(client)?.write(data);
    },
    close: closePeer,
    error: closePeer,
  },
});

function ok(data: unknown): { success: true; data: unknown } {
  return { success: true, data };
}

const app = new Hono();
app.use("/v1/*", async (requestContext, next) => {
  if (env.SANDBOX_API_KEY && requestContext.req.header("X-AIO-API-Key") !== env.SANDBOX_API_KEY)
    return requestContext.json({ success: false, message: "Unauthorized" }, 401);
  return next();
});

app.get("/health", (requestContext) => requestContext.json(ok({ ready: true })));
app.route("/v1/tools", toolRelay(env.BROWSER_WORKSPACE));
app.post("/v1/desktop", async (requestContext) => {
  const input = ComputerArgumentsSchema.parse(await requestContext.req.json());
  if (input.action === "screenshot") {
    const directory = mkdtempSync(join(tmpdir(), "slopbot-screen-"));
    try {
      const filename = join(directory, "screen.png");
      await desktopCommand(["scrot", "--overwrite", filename]);
      return new Response(await Bun.file(filename).arrayBuffer(), {
        headers: { "cache-control": "no-store", "content-type": "image/png" },
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  switch (input.action) {
    case "click":
      await desktopCommand(["xdotool", "mousemove", "--sync", String(input.x), String(input.y), "click", "--repeat", String(input.clickCount), String({ left: 1, middle: 2, right: 3 }[input.button])]);
      break;
    case "type":
      await desktopCommand(["xdotool", "type", "--clearmodifiers", "--delay", "1", "--", input.text]);
      break;
    case "key":
      await desktopCommand(["xdotool", "key", "--clearmodifiers", input.key]);
      break;
    case "scroll":
      await desktopCommand(["xdotool", "click", "--repeat", String(input.amount), String({ up: 4, down: 5, left: 6, right: 7 }[input.direction])]);
      break;
  }
  return requestContext.json(ok("done"));
});

async function desktopCommand(args: string[]): Promise<void> {
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const timer = globalThis.setTimeout(() => child.kill(), 15_000);
  try {
    const error = await new Response(child.stderr).text();
    if (await child.exited !== 0) throw new Error(`${args[0]} failed: ${error}`);
  } finally { clearTimeout(timer); }
}
app.get("/v1/browser/info", async (requestContext) =>
  requestContext.json(
    ok({
      ready: true,
      protocol: "cdp",
      cdp_url: env.BROWSER_CDP_PUBLIC_URL,
      url: (await page()).url(),
    }),
  ),
);
app.get("/v1/browser/screenshot", async () => {
  const image = await (await page()).screenshot({ type: "png" });
  return new Response(new Uint8Array(image), {
    headers: { "cache-control": "no-store", "content-type": "image/png" },
  });
});
app.post("/v1/browser/page/navigate", async (requestContext) => {
  const input = NavigateSchema.parse(await requestContext.req.json());
  await (await page()).goto(input.url, { waitUntil: "domcontentloaded" });
  return requestContext.json(ok(input.url));
});
app.get("/v1/browser/page/text", async (requestContext) =>
  requestContext.json(ok(await (await page()).locator("body").innerText())),
);
app.post("/v1/browser/page/click", async (requestContext) => {
  const input = ClickSchema.parse(await requestContext.req.json());
  const activePage = await page();
  if (input.selector) await activePage.locator(input.selector).click();
  else
    await activePage.mouse.click(input.x ?? 0, input.y ?? 0, {
      button: input.button,
      clickCount: input.click_count,
    });
  return requestContext.json(ok("clicked"));
});
app.post("/v1/browser/page/fill", async (requestContext) => {
  const input = FillSchema.parse(await requestContext.req.json());
  await (await page()).locator(input.selector).fill(input.text);
  return requestContext.json(ok("filled"));
});
app.post("/v1/browser/page/evaluate", async (requestContext) => {
  const input = EvaluateSchema.parse(await requestContext.req.json());
  return requestContext.json(ok(await (await page()).evaluate(input.expression)));
});
app.post("/v1/browser/page/scroll", async (requestContext) => {
  const input = ScrollSchema.parse(await requestContext.req.json());
  const horizontal = input.direction === "left" || input.direction === "right";
  const sign = input.direction === "up" || input.direction === "left" ? -1 : 1;
  await (await page()).mouse.wheel(horizontal ? sign * input.amount : 0, horizontal ? 0 : sign * input.amount);
  return requestContext.json(ok("scrolled"));
});
app.post("/v1/browser/page/press_key", async (requestContext) => {
  const input = KeySchema.parse(await requestContext.req.json());
  await (await page()).keyboard.press(input.key);
  return requestContext.json(ok("pressed"));
});

const publicDirectory = join(import.meta.dir, "..", "public");
const noVncDirectory = join(import.meta.dir, "..", "node_modules", "@novnc", "novnc");
app.get("/vnc", (requestContext) => requestContext.redirect("/vnc/vnc.html"));
app.get("/vnc/*", (requestContext) => {
  const filePath = join(publicDirectory, requestContext.req.path.slice("/vnc/".length));
  return relative(publicDirectory, filePath).startsWith("..") ? requestContext.notFound() : new Response(Bun.file(filePath));
});
app.get("/novnc/*", (requestContext) => {
  const filePath = join(noVncDirectory, requestContext.req.path.slice("/novnc/".length));
  return relative(noVncDirectory, filePath).startsWith("..") ? requestContext.notFound() : new Response(Bun.file(filePath));
});
app.onError((error, requestContext) =>
  requestContext.json({ success: false, message: error instanceof Error ? error.message : String(error) }, error instanceof z.ZodError ? 400 : 500),
);

type WebSocketData = { socket?: Bun.Socket<WebSocketData> };
const server = Bun.serve<WebSocketData>({
  port: env.PORT,
  hostname: env.LISTEN_HOST,
  fetch(request, bunServer) {
    if (new URL(request.url).pathname === "/v1/tools") bunServer.timeout(request, 0);
    if (new URL(request.url).pathname === "/websockify" && bunServer.upgrade(request, { data: {} }))
      return undefined;
    return app.fetch(request);
  },
  websocket: {
    open(webSocket) {
      void Bun.connect<WebSocketData>({
        hostname: "127.0.0.1",
        port: 5900,
        socket: {
          open(socket) {
            webSocket.data.socket = socket;
          },
          data(_socket, data) {
            webSocket.send(data);
          },
          close() {
            webSocket.close();
          },
          error(_socket, error) {
            webSocket.close(1011, error.message);
          },
        },
      });
    },
    message(webSocket, message) {
      webSocket.data.socket?.write(typeof message === "string" ? new TextEncoder().encode(message) : message);
    },
    close(webSocket) {
      webSocket.data.socket?.end();
    },
  },
});

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  server.stop();
  cdpProxy.stop(true);
  await context.close();
  for (const childProcess of processes) childProcess.kill();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("SIGHUP", () => void shutdown());
console.log(`SlopBot browser: http://127.0.0.1:${server.port}`);
