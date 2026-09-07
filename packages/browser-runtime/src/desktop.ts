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

type ProfileDesktop = Readonly<{
  context: BrowserContext;
  cdpPort: number;
  display: string;
  processes: readonly Bun.Subprocess[];
  vncPort: number;
}>;

export type Desktop = Readonly<{
  context(profile: string): Promise<BrowserContext>;
  command(profile: string, args: readonly string[]): Promise<void>;
  cdpPort(profile: string): number;
  vncPort(profile: string): number;
  profileCount(): number;
  close(): Promise<void>;
}>;

function displayBase(display: string): number {
  const match = /^:(\d+)$/.exec(display);
  if (!match?.[1]) throw new Error(`Invalid X display: ${display}`);
  return Number(match[1]);
}

export async function startDesktop(options: DesktopOptions): Promise<Desktop> {
  mkdirSync(join(options.BROWSER_WORKSPACE, "Downloads"), { recursive: true });
  const desktops = new Map<string, ProfileDesktop>();
  const launches = new Map<string, Promise<ProfileDesktop>>();
  const firstDisplay = displayBase(options.DISPLAY);
  let nextIndex = 0;

  const profileDirectory = (profile: string): string =>
    profile === "lead"
      ? options.BROWSER_PROFILE_DIR
      : join(options.BROWSER_PROFILE_DIR, "..", "browser-profiles", profile);

  const launch = async (profile: string): Promise<ProfileDesktop> => {
    const existing = desktops.get(profile);
    if (existing) return existing;
    const pending = launches.get(profile);
    if (pending) return pending;
    const launching = (async () => {
      const index = nextIndex++;
      const display = `:${firstDisplay + index}`;
      const vncPort = 5900 + index;
      const cdpPort = options.BROWSER_CDP_PORT + index;
      const environment = { ...process.env, DISPLAY: display };
      const directory = profileDirectory(profile);
      const downloads = join(options.BROWSER_WORKSPACE, "Downloads", profile);
      mkdirSync(directory, { recursive: true });
      mkdirSync(downloads, { recursive: true });
      for (const lockFile of ["SingletonCookie", "SingletonLock", "SingletonSocket"])
        rmSync(join(directory, lockFile), { force: true });

      const processes: Bun.Subprocess[] = [
        Bun.spawn(["Xvfb", display, "-screen", "0", "1280x1024x24", "-ac", "-nolisten", "tcp"]),
      ];
      await setTimeout(500);
      processes.push(
        Bun.spawn(["openbox"], { env: environment }),
        Bun.spawn(["x11vnc", "-display", display, "-rfbport", String(vncPort), "-localhost", "-forever", "-shared", "-nopw"], { env: environment }),
        Bun.spawn(["xterm", "-geometry", "88x24+20+40", "-title", `${profile} · SlopBot VM`], {
          cwd: options.BROWSER_WORKSPACE,
          env: environment,
        }),
      );
      try {
        const context = await chromium.launchPersistentContext(directory, {
          executablePath: "/usr/bin/chromium",
          headless: false,
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
          chromiumSandbox: process.getuid?.() !== 0,
          env: environment,
          args: [
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
            "--window-position=0,0",
            "--window-size=1280,1024",
            `--remote-debugging-port=${cdpPort}`,
          ],
          acceptDownloads: true,
          downloadsPath: downloads,
          viewport: null,
        });
        const desktop = { context, cdpPort, display, processes, vncPort } satisfies ProfileDesktop;
        desktops.set(profile, desktop);
        return desktop;
      } catch (error) {
        for (const process of processes) process.kill();
        throw error;
      }
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
    async context(profile) {
      return (await launch(profile)).context;
    },
    async command(profile, args) {
      const desktop = await launch(profile);
      const child = Bun.spawn([...args], {
        env: { ...process.env, DISPLAY: desktop.display },
        stdout: "ignore",
        stderr: "pipe",
      });
      const timer = globalThis.setTimeout(() => child.kill(), 15_000);
      try {
        const error = await new Response(child.stderr).text();
        if (await child.exited !== 0) throw new Error(`${args[0] ?? "command"} failed: ${error}`);
      } finally {
        clearTimeout(timer);
      }
    },
    cdpPort(profile) {
      const desktop = desktops.get(profile);
      if (!desktop) throw new Error(`Browser profile is not active: ${profile}`);
      return desktop.cdpPort;
    },
    vncPort(profile) {
      const desktop = desktops.get(profile);
      if (!desktop) throw new Error(`Desktop profile is not active: ${profile}`);
      return desktop.vncPort;
    },
    profileCount: () => desktops.size,
    async close() {
      await Promise.all([...desktops.values()].map(({ context }) => context.close()));
      for (const desktop of desktops.values())
        for (const process of desktop.processes) process.kill();
    },
  };
}
