import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright-core";
import type { BrowserContext } from "playwright-core";

type DesktopOptions = { DISPLAY: string; BROWSER_PROFILE_DIR: string; BROWSER_WORKSPACE: string; BROWSER_CDP_PORT: number };

export async function startDesktop(options: DesktopOptions): Promise<{ context: BrowserContext; close(): Promise<void> }> {
  for (const lockFile of ["SingletonCookie", "SingletonLock", "SingletonSocket"])
    rmSync(join(options.BROWSER_PROFILE_DIR, lockFile), { force: true });
  mkdirSync(join(options.BROWSER_WORKSPACE, "Downloads"), { recursive: true });

  const processes = [
    Bun.spawn(["Xvfb", options.DISPLAY, "-screen", "0", "1280x1024x24", "-ac", "-nolisten", "tcp"]),
  ];
  await setTimeout(500);
  processes.push(
    Bun.spawn(["openbox"]),
    Bun.spawn(["x11vnc", "-display", options.DISPLAY, "-rfbport", "5900", "-localhost", "-forever", "-shared", "-nopw"]),
  );

  const context = await chromium.launchPersistentContext(options.BROWSER_PROFILE_DIR, {
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
      `--remote-debugging-port=${options.BROWSER_CDP_PORT}`,
    ],
    acceptDownloads: true,
    downloadsPath: join(options.BROWSER_WORKSPACE, "Downloads"),
    viewport: null,
  });
  processes.push(Bun.spawn(["xterm", "-geometry", "88x24+20+40", "-title", "SlopBot VM"], { cwd: options.BROWSER_WORKSPACE }));

  return {
    context,
    async close() {
      await context.close();
      for (const childProcess of processes) childProcess.kill();
    },
  };
}
