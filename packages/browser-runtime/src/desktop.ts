import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright-core";
import type { BrowserContext } from "playwright-core";

type DesktopOptions = {
  DISPLAY: string;
  BROWSER_PROFILE_DIR: string;
  BROWSER_WORKSPACE: string;
  BROWSER_CDP_PORT: number;
};

export type Desktop = Readonly<{
  context(profile: string): Promise<BrowserContext>;
  cdpPort(profile: string): number;
  profileCount(): number;
  close(): Promise<void>;
}>;

export async function startDesktop(options: DesktopOptions): Promise<Desktop> {
  mkdirSync(join(options.BROWSER_WORKSPACE, "Downloads"), { recursive: true });
  const processes = [
    Bun.spawn(["Xvfb", options.DISPLAY, "-screen", "0", "1280x1024x24", "-ac", "-nolisten", "tcp"]),
  ];
  await setTimeout(500);
  processes.push(
    Bun.spawn(["openbox"]),
    Bun.spawn(["x11vnc", "-display", options.DISPLAY, "-rfbport", "5900", "-localhost", "-forever", "-shared", "-nopw"]),
    Bun.spawn(["xterm", "-geometry", "88x24+20+40", "-title", "SlopBot VM"], { cwd: options.BROWSER_WORKSPACE }),
  );

  const contexts = new Map<string, BrowserContext>();
  const launches = new Map<string, Promise<BrowserContext>>();
  const ports = new Map<string, number>();
  let nextPort = options.BROWSER_CDP_PORT;

  const profileDirectory = (profile: string): string =>
    profile === "lead"
      ? options.BROWSER_PROFILE_DIR
      : join(options.BROWSER_PROFILE_DIR, "..", "browser-profiles", profile);

  const launch = async (profile: string): Promise<BrowserContext> => {
    const existing = contexts.get(profile);
    if (existing) return existing;
    const pending = launches.get(profile);
    if (pending) return pending;
    const launching = (async () => {
      const directory = profileDirectory(profile);
      for (const lockFile of ["SingletonCookie", "SingletonLock", "SingletonSocket"])
        rmSync(join(directory, lockFile), { force: true });
      const downloads = join(options.BROWSER_WORKSPACE, "Downloads", profile);
      mkdirSync(downloads, { recursive: true });
      const port = nextPort++;
      const context = await chromium.launchPersistentContext(directory, {
        executablePath: "/usr/bin/chromium",
        headless: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        chromiumSandbox: process.getuid?.() !== 0,
        args: [
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--window-position=0,0",
          "--window-size=1280,1024",
          `--remote-debugging-port=${port}`,
        ],
        acceptDownloads: true,
        downloadsPath: downloads,
        viewport: null,
      });
      contexts.set(profile, context);
      ports.set(profile, port);
      return context;
    })();
    launches.set(profile, launching);
    try {
      return await launching;
    } finally {
      launches.delete(profile);
    }
  };

  await launch("lead");

  return {
    context: launch,
    cdpPort(profile) {
      const port = ports.get(profile);
      if (port === undefined) throw new Error(`Browser profile is not active: ${profile}`);
      return port;
    },
    profileCount: () => contexts.size,
    async close() {
      await Promise.all([...contexts.values()].map((context) => context.close()));
      for (const childProcess of processes) childProcess.kill();
    },
  };
}
