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
  private readonly browsers = new Map<string, SandboxBrowser>();
  private readonly options: SandboxComputerOptions;

  constructor(options: SandboxComputerOptions) {
    this.options = SandboxComputerOptionsSchema.parse(options);
  }

  get screenCount(): number {
    return this.options.baseUrls.length;
  }

  assignment(agentId: AgentId, screen: number): DesktopAssignment {
    const publicUrl = this.options.publicUrls[screen];
    if (!publicUrl) throw new Error("No sandbox browser available");
    return DesktopAssignmentSchema.parse({
      computerId: "slopbot-browser",
      screen,
      browserProfile: agentId,
      viewerUrl: `${publicUrl.replace(/\/$/, "")}/vnc/vnc.html`,
    });
  }

  browser(agentId: AgentId, screen: number): SandboxBrowser {
    const url = this.options.baseUrls[screen];
    if (!url) throw new Error("No sandbox browser available");
    const key = `${screen}:${agentId}`;
    const existing = this.browsers.get(key);
    if (existing) return existing;
    const browser = new SandboxBrowser(url, agentId, this.options.apiKey);
    this.browsers.set(key, browser);
    return browser;
  }
}
