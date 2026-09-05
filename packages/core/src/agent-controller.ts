import { createHash } from "node:crypto";
import { z } from "zod";

import { AgentStore } from "./agent-store.ts";
import type { StoredAgent } from "./agent-store.ts";
import {
  AgentIdSchema,
  AgentProfileSchema,
  ImageAttachmentsSchema,
  createAgentId,
} from "./agent-types.ts";
import type {
  AgentId,
  AgentProfile,
  AgentStatus,
  AgentView,
  DesktopAssignment,
  ImageAttachment,
  MessageEnvelope,
} from "./agent-types.ts";
import {
  BrowserArgumentsSchema,
  BrowserInputSchema,
  ComputerArgumentsSchema,
} from "./sandbox-browser.ts";
import type { SandboxBrowser } from "./sandbox-browser.ts";
import { PiRuntime } from "./pi-runtime.ts";
import type {
  DynamicTool,
  CreateSkillInput,
  TurnStatus,
  SandboxMode,
  Skill,
  ThreadId,
  ThreadOptions,
  TurnInput,
} from "./pi-runtime.ts";
import { errorMessage, textSchema } from "./protocol.ts";
import {
  SandboxComputer,
  SandboxComputerOptionsSchema,
} from "./sandbox-computer.ts";

export const AgentControllerOptionsSchema = z.object({
  cwd: z.string().min(1),
  databasePath: z.string().min(1),
  computer: SandboxComputerOptionsSchema.optional(),
});
const UserMessageSchema = z
  .object({
    agentId: AgentIdSchema,
    text: z.string().trim().max(8_000),
    images: ImageAttachmentsSchema,
    skillName: textSchema(100).nullish(),
  })
  .refine(({ text, images }) => Boolean(text || images.length), {
    message: "A message or image is required",
  });
export const UpdateAgentInputSchema = z.object({
  name: textSchema(50),
  role: textSchema(200),
  instructions: textSchema(2_000),
});

export type AgentControllerOptions = Readonly<
  z.infer<typeof AgentControllerOptionsSchema>
>;
type Agent = Readonly<{
  profile: AgentProfile;
  threadId: ThreadId;
  desktop: DesktopAssignment | null;
}> & { status: AgentStatus };

type ActiveMessage = {
  message: MessageEnvelope;
};

const messageRetryLimit = 3;

export const defaultAgentProfiles = [{
  id: createAgentId("lead"),
  name: "SlopBot",
  aliases: ["lead", "slopbot"],
  role: "Personal assistant for research and implementation",
  sandbox: "workspace-write",
  instructions: "Handle the user's task directly. Inspect evidence, use your browser and tools when useful, preserve unrelated work, and report verified results.",
}] satisfies readonly [AgentProfile];

const browserTool = {
  type: "function",
  name: "browser",
  description:
    "Control your assigned sandbox browser. Navigate, inspect visible text, click a CSS selector, type into a selector, or evaluate page JavaScript.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "snapshot", "click", "type", "evaluate"],
      },
      url: { type: "string" },
      selector: { type: "string" },
      text: { type: "string" },
      expression: { type: "string" },
    },
    required: ["action"],
    additionalProperties: false,
  },
} satisfies DynamicTool;

const computerTool = {
  type: "function",
  name: "computer",
  description: "Control the separate Linux VM desktop shared with the user. Take a screenshot before using pixel coordinates (1280x1024). Click, type literal text, scroll, or press X11 keys such as Return, ctrl+l, alt+F2. Launch VM apps through its desktop terminal or Run dialog, not the host bash tool. Screenshots return images.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["screenshot", "click", "type", "key", "scroll"] },
      x: { type: "integer" }, y: { type: "integer" },
      button: { type: "string", enum: ["left", "middle", "right"] },
      clickCount: { type: "integer" }, text: { type: "string" }, key: { type: "string" },
      direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "integer" },
    },
    required: ["action"],
    additionalProperties: false,
  },
} satisfies DynamicTool;

export class AgentController {
  private readonly agents = new Map<AgentId, Agent>();
  private readonly activeMessages = new Map<AgentId, ActiveMessage>();
  private readonly computer: SandboxComputer | undefined;
  private readonly options: AgentControllerOptions;
  private readonly store: AgentStore;
  private skills: readonly Skill[] = [];

  constructor(
    private readonly runtime: PiRuntime,
    options: AgentControllerOptions,
  ) {
    this.options = AgentControllerOptionsSchema.parse(options);
    this.store = new AgentStore(this.options.databasePath);
    this.computer = this.options.computer
      ? new SandboxComputer(this.options.computer)
      : undefined;
  }

  async initialize(): Promise<void> {
    this.runtime.onToolCall = (threadId, tool, input) => this.handleToolCall(threadId, tool, input);
    this.runtime.onText = (threadId, delta) => this.handleText(threadId, delta);
    this.runtime.onTurnComplete = (threadId, status) => this.handleTurnComplete(threadId, status);
    await this.runtime.connect();
    await this.reloadSkills();
    const profile = defaultAgentProfiles[0];
    this.store.prepareSingleBot(profile);
    const stored = this.store.getAgent(profile.id);
    if (!stored) throw new Error("Bot configuration is missing");
    await this.loadAgent(stored);
    await this.recoverPendingMessages();
    for (const agent of this.agents.values()) this.schedule(agent);
  }

  close(): void {
    this.runtime.close();
    this.store.close();
  }

  listAgents(): readonly AgentView[] {
    return [...this.agents.values()].map((agent) => this.view(agent));
  }

  botProfile(): AgentProfile {
    return this.agent(defaultAgentProfiles[0].id).profile;
  }

  async updateBot(input: z.infer<typeof UpdateAgentInputSchema>): Promise<AgentProfile> {
    const agent = this.agent(defaultAgentProfiles[0].id);
    if (agent.status === "running" || this.store.hasPendingMessages(agent.profile.id))
      throw new Error("Wait for the bot to finish before editing its configuration");
    const profile = AgentProfileSchema.parse({ ...agent.profile, ...UpdateAgentInputSchema.parse(input) });
    agent.status = "running";
    try {
      this.store.updateProfile(profile);
      await this.loadAgent({ profile, threadId: agent.threadId, threadConfig: null });
      this.schedule(this.agent(profile.id));
      return profile;
    } catch (error) {
      this.store.updateProfile(agent.profile);
      agent.status = "idle";
      this.schedule(agent);
      throw error;
    }
  }

  listSkills(): readonly Skill[] {
    return this.skills;
  }

  async createSkill(input: CreateSkillInput): Promise<Skill> {
    const created = await this.runtime.createSkill(input);
    await this.reloadSkills();
    const skill = this.skills.find((item) => item.name === created.name);
    if (!skill) throw new Error("Skill was not created");
    return skill;
  }

  sendMessage(
    rawAgentId: string,
    text: string,
    skillName?: string,
    images: readonly ImageAttachment[] = [],
  ): MessageEnvelope {
    const parsed = UserMessageSchema.parse({
      agentId: rawAgentId,
      text,
      images,
      skillName,
    });
    const agent = this.agent(parsed.agentId);
    const skill = parsed.skillName
      ? this.skills.find((item) => item.name === parsed.skillName)
      : undefined;
    if (parsed.skillName && !skill)
      throw new Error("Skill not found");
    const message = this.store.queueMessage({
      senderId: null,
      recipientId: agent.profile.id,
      parentId: null,
      replyRequired: false,
      text: parsed.text || "Please inspect the attached image.",
      images: parsed.images,
      skillName: parsed.skillName ?? null,
    });
    this.schedule(agent);
    return message;
  }

  async clearChat(rawAgentId: string): Promise<AgentView> {
    const agent = this.agent(AgentIdSchema.parse(rawAgentId));
    if (agent.status === "running") {
      throw new Error("Wait for the agent to finish before clearing its chat");
    }
    const options = this.threadOptions(agent.profile, agent.desktop);
    const threadId = await this.runtime.startThread(options);
    const updated = { ...agent, threadId, status: "idle" } satisfies Agent;
    this.store.clearAgentChat(agent.profile.id);
    this.store.setThread(
      agent.profile.id,
      threadId,
      this.threadConfig(options),
    );
    this.agents.set(agent.profile.id, updated);
    return this.view(updated);
  }

  async browserScreenshot(rawAgentId: string): Promise<Uint8Array> {
    return this.browser(rawAgentId).screenshot();
  }

  async browserInput(rawAgentId: string, input: unknown): Promise<void> {
    return this.browser(rawAgentId).input(BrowserInputSchema.parse(input));
  }

  private async loadAgent(stored: StoredAgent): Promise<void> {
    const desktop = this.assignDesktop(stored.profile.id);
    const options = this.threadOptions(stored.profile, desktop);
    const threadConfig = this.threadConfig(options);
    let threadId = stored.threadId;
    if (threadId) {
      try {
        threadId = await this.runtime.resumeThread(threadId, options);
      } catch (error) {
        console.warn(
          `Could not resume ${stored.profile.id}: ${errorMessage(error)}`,
        );
        threadId = null;
      }
    }
    if (!threadId) {
      threadId = await this.runtime.startThread(options);
    }
    this.store.setThread(stored.profile.id, threadId, threadConfig);
    this.agents.set(stored.profile.id, {
      profile: stored.profile,
      threadId,
      desktop,
      status: "idle",
    });
  }

  private threadOptions(
    profile: AgentProfile,
    desktop: DesktopAssignment | null,
  ): ThreadOptions {
    return {
      cwd: this.options.cwd,
      approvalPolicy: "never",
      sandbox: this.sandboxFor(profile),
      serviceName: "slopbot",
      developerInstructions: this.instructionsFor(profile, desktop),
      dynamicTools: desktop ? [browserTool, computerTool] : [],
    };
  }

  private async recoverPendingMessages(): Promise<void> {
    for (const message of this.store.listProcessingMessages()) {
      const recipient = this.agents.get(message.recipientId);
      if (!recipient || message.senderId) continue;
      if (
        await this.runtime.threadContainsText(recipient.threadId, message.id)
      ) {
        this.store.markCompleted(message.id);
      } else {
        this.store.requeueMessage(message.id, messageRetryLimit);
      }
    }
  }

  private instructionsFor(
    profile: AgentProfile,
    desktop: DesktopAssignment | null,
  ): string {
    const computer = desktop
      ? " The browser and computer tools target a separate Linux VM, not the host. Its /workspace is a shared mount, not your host working directory. To run commands inside the VM, use its desktop terminal; normal bash runs on the host. If the VM is unavailable, report that for remote operations; host tools remain available."
      : "";
    return `You are ${profile.name} with stable agent ID ${profile.id}. ${profile.role}. ${profile.instructions} Your runtime runs on ${process.platform === "darwin" ? "macOS" : process.platform}. Your host workspace is ${this.options.cwd}. The read, write, edit, grep, find, ls, and bash tools operate locally on this host, like a normal coding agent. Earlier conversation describing those tools as VM-relayed is outdated.${computer} You are the only bot. Complete tasks directly. Follow relevant skills and never claim an action succeeded without tool evidence.`;
  }

  private view(agent: Agent): AgentView {
    return {
      id: agent.profile.id,
      name: agent.profile.name,
      role: agent.profile.role,
      sandbox: this.sandboxFor(agent.profile),
      threadId: agent.threadId,
      desktop: agent.desktop,
      messages: [...this.store.listMessages(agent.profile.id)],
      status: agent.status,
    };
  }

  private threadConfig(options: ThreadOptions): string {
    return createHash("sha256").update(JSON.stringify(options)).digest("hex");
  }

  private agent(agentId: AgentId): Agent {
    const agent = this.agents.get(agentId);
    if (!agent)
      throw new Error("Agent not found");
    return agent;
  }

  private browser(rawAgentId: string): SandboxBrowser {
    const agent = this.agent(AgentIdSchema.parse(rawAgentId));
    if (!agent.desktop || !this.computer)
      throw new Error("Browser access is unavailable");
    return this.computer.browser(agent.desktop.screen);
  }

  private sandboxFor(profile: AgentProfile): SandboxMode {
    return this.computer ? "danger-full-access" : profile.sandbox;
  }

  private assignDesktop(agentId: AgentId): DesktopAssignment | null {
    if (!this.computer) return null;
    const screen = this.store.assignDesktop(agentId, this.computer.screenCount);
    if (screen === undefined) return null;
    return this.computer.assignment(agentId, screen);
  }

  private agentByThread(threadId: string): Agent | undefined {
    return [...this.agents.values()].find(
      (agent) => agent.threadId === threadId,
    );
  }

  private schedule(agent: Agent): void {
    queueMicrotask(() => void this.runNext(agent));
  }

  private async runNext(agent: Agent): Promise<void> {
    if (agent.status === "running") return;
    const message = this.store.claimNextMessage(agent.profile.id);
    if (!message) return;

    agent.status = "running";
    const active = { message } satisfies ActiveMessage;
    this.activeMessages.set(agent.profile.id, active);
    try {
      const skill = message.skillName
        ? this.skills.find((item) => item.name === message.skillName)
        : undefined;
      if (message.skillName && !skill)
        throw new Error(`Skill not found: ${message.skillName}`);
      const text = `SlopBot user message ${message.id}:\n\n${message.text}`;
      const input: TurnInput[] = [
        {
          type: "text",
          text,
          text_elements: [],
        },
      ];
      input.push(
        ...message.images.map((image) => ({ type: "image" as const, ...image })),
      );
      if (skill)
        input.push({ type: "skill", name: skill.name, path: skill.path });
      const turnId = await this.runtime.startTurn(agent.threadId, input);
      this.store.setTurn(message.id, turnId);
    } catch (error) {
      this.store.markFailed(message.id);
      this.activeMessages.delete(agent.profile.id);
      this.store.addAssistantMessage(
        agent.profile.id,
        `Error: ${errorMessage(error)}`,
      );
      agent.status = "error";
    }
  }

  private async handleToolCall(
    threadId: ThreadId,
    tool: string,
    input: unknown,
  ): Promise<string | ImageAttachment> {
    const sender = this.agentByThread(threadId);
    if (!sender) throw new Error("Sender agent not found");
    if (tool === "computer") {
      return this.browser(sender.profile.id).computer(ComputerArgumentsSchema.parse(input));
    }
    if (tool === "browser") {
      if (!sender.desktop) throw new Error("Browser access is unavailable");
      const parsed = BrowserArgumentsSchema.safeParse(input);
      if (!parsed.success) throw new Error("Invalid browser request");
      return this.browser(sender.profile.id).execute(parsed.data);
    }
    throw new Error("Unknown tool");
  }

  private handleText(threadId: ThreadId, delta: string): void {
    const agent = this.agentByThread(threadId);
    if (!agent) return;
    const last = this.store.lastMessage(agent.profile.id);
    if (last?.role === "assistant")
      this.store.updateMessageText(last.id, last.text + delta);
    else this.store.addAssistantMessage(agent.profile.id, delta);
  }

  private handleTurnComplete(threadId: ThreadId, status: TurnStatus): void {
    const agent = this.agentByThread(threadId);
    if (!agent) return;
    const active = this.activeMessages.get(agent.profile.id);
    if (active) {
      if (status === "completed") {
        this.store.markCompleted(active.message.id);
      } else {
        this.store.markFailed(active.message.id);
      }
      this.activeMessages.delete(agent.profile.id);
    }
    agent.status = status === "completed" ? "idle" : "error";
    this.schedule(agent);
  }

  private async reloadSkills(): Promise<void> {
    this.skills = (await this.runtime.listSkills()).toSorted(
      (left, right) => left.name.localeCompare(right.name),
    );
  }
}
