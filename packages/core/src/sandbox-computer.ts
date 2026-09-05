import { setTimeout } from "node:timers/promises";

import { z } from "zod";

import { DesktopAssignmentSchema } from "./agent-types.ts";
import type { AgentId, DesktopAssignment } from "./agent-types.ts";
import { SandboxBrowser } from "./sandbox-browser.ts";

export const SandboxComputerOptionsSchema = z
  .object({
    baseUrls: z.array(z.url()).length(1),
    publicUrls: z.array(z.url()).length(1),
    apiKey: z.string().min(1).optional(),
  })
  .refine(({ baseUrls, publicUrls }) => baseUrls.length === publicUrls.length, {
    message: "Sandbox base and public URL counts must match",
  });

export type SandboxComputerOptions = Readonly<
  z.infer<typeof SandboxComputerOptionsSchema>
>;

export class SandboxComputer {
  private readonly browsers: readonly SandboxBrowser[];
  private readonly options: SandboxComputerOptions;

  constructor(options: SandboxComputerOptions) {
    this.options = SandboxComputerOptionsSchema.parse(options);
    this.browsers = this.options.baseUrls.map(
      (url) => new SandboxBrowser(url, this.options.apiKey),
    );
  }

  async start(): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await Promise.all(this.browsers.map((browser) => browser.connect()));
        return;
      } catch (error) {
        if (attempt === 59) throw error;
        await setTimeout(500);
      }
    }
  }

  get screenCount(): number {
    return this.browsers.length;
  }

  assignment(_agentId: AgentId, screen: number): DesktopAssignment {
    const publicUrl = this.options.publicUrls[screen];
    if (!publicUrl) throw new Error("No sandbox browser available");
    return DesktopAssignmentSchema.parse({
      computerId: "slopbot-browser",
      screen,
      viewerUrl: `${publicUrl.replace(/\/$/, "")}/vnc/vnc.html`,
    });
  }

  browser(screen: number): SandboxBrowser {
    const browser = this.browsers[screen];
    if (!browser) throw new Error("No sandbox browser available");
    return browser;
  }
}
