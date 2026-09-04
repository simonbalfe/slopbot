import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";

import { DesktopAssignmentSchema } from "./agent-types.ts";
import type { AgentId, DesktopAssignment } from "./agent-types.ts";

export const SharedComputerOptionsSchema = z.object({
  display: z.string().regex(/^:\d+$/).default(":99"),
  screens: z.coerce.number().int().min(1).max(16).default(6),
  geometry: z.string().regex(/^\d+x\d+x\d+$/).default("1920x1080x24"),
  browserProfileRoot: z.string().min(1),
  viewerBaseUrl: z.url().optional(),
});

export type SharedComputerOptions = Readonly<z.infer<typeof SharedComputerOptionsSchema>>;

export class SharedComputer {
  private readonly activeScreens = new Set<number>();
  private readonly options: SharedComputerOptions;
  private readonly processes: ChildProcess[] = [];

  constructor(options: SharedComputerOptions) {
    this.options = SharedComputerOptionsSchema.parse(options);
  }

  async start(): Promise<void> {
    if (!existsSync(this.socketPath)) {
      const screens = Array.from({ length: this.options.screens }, (_, screen) => [
        "-screen",
        String(screen),
        this.options.geometry,
      ]).flat();
      const xServer = this.launch("Xvfb", [this.options.display, "-nolisten", "tcp", "-noreset", ...screens]);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (existsSync(this.socketPath)) break;
        if (xServer.exitCode !== null) throw new Error(`Xvfb exited (${xServer.exitCode})`);
        await setTimeout(50);
      }
    }
    if (!existsSync(this.socketPath)) throw new Error(`Xvfb did not create ${this.socketPath}`);
    await Promise.all(Array.from({ length: this.options.screens }, (_, screen) => this.startScreen(screen)));
  }

  close(): void {
    for (const process of this.processes) process.kill();
    this.processes.length = 0;
  }

  displayFor(screen: number): string {
    if (screen < 0 || screen >= this.options.screens) throw new Error("No X11 screen available");
    return `${this.options.display}.${screen}`;
  }

  get screenCount(): number {
    return this.options.screens;
  }

  get display(): string {
    return this.options.display;
  }

  assignment(agentId: AgentId, screen: number): DesktopAssignment {
    return DesktopAssignmentSchema.parse({
      computerId: "shared",
      display: this.displayFor(screen),
      screen,
      browserProfile: join(this.options.browserProfileRoot, agentId),
      cdpUrl: `http://127.0.0.1:${9222 + screen}`,
      viewerUrl: this.options.viewerBaseUrl
        ? `${this.options.viewerBaseUrl}:${6080 + screen}/vnc.html?autoconnect=1&resize=scale`
        : null,
    });
  }

  openDesktop(assignment: DesktopAssignment): void {
    if (this.activeScreens.has(assignment.screen)) return;
    mkdirSync(assignment.browserProfile, { recursive: true });
    for (const lock of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
      rmSync(join(assignment.browserProfile, lock), { force: true });
    }
    const [width, height] = this.options.geometry.split("x");
    this.launch("chromium", [
      `--user-data-dir=${assignment.browserProfile}`,
      `--remote-debugging-port=${new URL(assignment.cdpUrl).port}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${width},${height}`,
      "--window-position=0,0",
      "about:blank",
    ], { DISPLAY: assignment.display });
    this.activeScreens.add(assignment.screen);
  }

  private async startScreen(screen: number): Promise<void> {
    const display = this.displayFor(screen);
    this.launch("openbox", [], { DISPLAY: display });
    if (!this.options.viewerBaseUrl) return;
    this.launch("x11vnc", [
      "-display", display,
      "-rfbport", String(5900 + screen),
      "-localhost",
      "-forever",
      "-shared",
      "-nopw",
    ]);
    this.launch("websockify", [
      "--web=/usr/share/novnc",
      String(6080 + screen),
      `127.0.0.1:${5900 + screen}`,
    ]);
    await setTimeout(100);
  }

  private launch(command: string, args: readonly string[], environment?: Readonly<Record<string, string>>): ChildProcess {
    const child = spawn(command, [...args], {
      env: environment ? { ...process.env, ...environment } : process.env,
      stdio: "inherit",
    });
    this.processes.push(child);
    return child;
  }

  private get socketPath(): string {
    return `/tmp/.X11-unix/X${this.options.display.slice(1)}`;
  }
}
