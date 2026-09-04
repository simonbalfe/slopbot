import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

import { startLocalComputer } from "./local-computer.ts";

const port = 4317;
const remoteUrl = process.env["SLOPBOT_SERVER_URL"];
const url = remoteUrl ? new URL(remoteUrl).toString().replace(/\/$/, "") : `http://127.0.0.1:${port}`;
let backend: ChildProcess | undefined;
let localComputer: ReturnType<typeof startLocalComputer>;

async function serverIsReady(): Promise<boolean> {
  try {
    return (await fetch(`${url}/api/agents`)).ok;
  } catch {
    return false;
  }
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await serverIsReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("SlopBot server did not start");
}

async function startBackend(): Promise<void> {
  if (await serverIsReady()) return;
  if (remoteUrl) throw new Error(`SlopBot server is unavailable: ${url}`);
  backend = spawn("bun", ["src/index.ts"], {
    cwd: join(app.getAppPath(), "..", "server"),
    env: { ...process.env, SLOPBOT_DATA_DIR: app.getPath("userData"), PORT: String(port) },
    stdio: "inherit",
  });
  await waitForServer();
}

async function createWindow(): Promise<void> {
  await startBackend();
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#090b0d",
    title: "SlopBot",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL(url);
}

void app.whenReady().then(() => {
  localComputer = startLocalComputer();
  return createWindow();
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  backend?.kill();
  localComputer?.close();
});
