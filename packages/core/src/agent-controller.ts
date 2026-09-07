import { toolParameters } from "@slopbot/contracts/computer";
import { z } from "zod";

import { AgentStore } from "./agent-store.ts";
import type { StoredAgent } from "./agent-store.ts";
import {
  AgentIdSchema,
  ApprovalRequestSchema,
  AgentProfileSchema,
  ImageAttachmentsSchema,
  createAgentId,
} from "./agent-types.ts";
import type {
  AgentId,
  AgentProfile,
  AgentStatus,
  AgentView,
  ApprovalRequest,
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
import type { AgentRuntime } from "./pi-runtime.ts";
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
export const CreateAgentInputSchema = z.object({
  id: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .pipe(AgentIdSchema),
  name: textSchema(50),
  role: textSchema(200),
  instructions: textSchema(2_000),
});
export const UpdateAgentInputSchema = z.object({
  name: textSchema(50),
  role: textSchema(200),
  instructions: textSchema(2_000),
});
const SendToAgentArgumentsSchema = z.object({
  target: textSchema(50),
  message: textSchema(8_000),
});

export type AgentControllerOptions = Readonly<
  z.infer<typeof AgentControllerOptionsSchema>
>;
export type CreateAgentInput = Readonly<z.infer<typeof CreateAgentInputSchema>>;
type Agent = Readonly<{
  profile: AgentProfile;
  threadId: ThreadId;
  desktop: DesktopAssignment | null;
}> & { status: AgentStatus };

type ActiveMessage = {
  message: MessageEnvelope;
  replied: boolean;
};

type PendingApproval = Readonly<{
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
}>;

const messageRetryLimit = 3;
const singleBotInstructions = "Handle the user's task directly. Inspect evidence, use your browser and tools when useful, preserve unrelated work, and report verified results.";

export const defaultAgentProfiles = [
  {
    id: createAgentId("lead"),
    name: "LEAD",
    aliases: ["lead", "manager", "slopbot"],
    role: "Coordinates work and owns the final answer",
    sandbox: "workspace-write",
    instructions: "Own intake, delegation, and synthesis. Delegate useful execution to teammates and report only results they actually return.",
  },
  {
    id: createAgentId("worker"),
    name: "WORKER",
    aliases: ["worker", "researcher", "builder", "reviewer", "ops"],
    role: "Researches, builds, reviews, and operates",
    sandbox: "workspace-write",
    instructions: "Inspect the real flow, gather evidence, implement focused changes, and verify them. Preserve unrelated work and send material results and remaining risks to LEAD.",
  },
] satisfies readonly [AgentProfile, AgentProfile];

const sendToAgentTool = {
  type: "function",
  name: "send_to_agent",
  description: "Queue an asynchronous message to another SlopBot bot and return its stable message ID.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "Target bot ID, name, or alias" },
      message: { type: "string", description: "Concise request, result, or handoff" },
    },
    required: ["target", "message"],
    additionalProperties: false,
  },
} satisfies DynamicTool;

const browserTool = {
  type: "function",
  name: "browser",
  description:
    "Control your assigned sandbox browser. Navigate, inspect visible text, click a CSS selector, type into a selector, or evaluate page JavaScript.",
  inputSchema: toolParameters(BrowserArgumentsSchema),
} satisfies DynamicTool;

const computerTool = {
  type: "function",
  name: "computer",
  description: "Control the separate Linux VM desktop shared with the user. Take a screenshot before using pixel coordinates (1280x1024). Click, type literal text, scroll, or press X11 keys such as Return, ctrl+l, alt+F2. Launch VM apps through its desktop terminal or Run dialog, not the host bash tool. Screenshots return images.",
  inputSchema: toolParameters(ComputerArgumentsSchema),
} satisfies DynamicTool;

function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+agent$/, "");
}

export class AgentController {
  private readonly agents = new Map<AgentId, Agent>();
  private readonly activeMessages = new Map<AgentId, ActiveMessage>();
  private readonly pendingApprovals = new Map<AgentId, PendingApproval>();
  private readonly computer: SandboxComputer | undefined;
  private readonly options: AgentControllerOptions;
  private readonly store: AgentStore;
  private skills: readonly Skill[] = [];

  constructor(
    private readonly runtime: AgentRuntime,
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
    this.runtime.onApprovalRequest = (threadId, tool, input) => this.authorizeTool(threadId, tool, input);
    this.runtime.onText = (threadId, delta) => this.handleText(threadId, delta);
    this.runtime.onTurnComplete = (threadId, status) => this.handleTurnComplete(threadId, status);
    await this.runtime.connect();
    await this.reloadSkills();
    this.store.upsertProfiles(defaultAgentProfiles);
    const lead = this.store.getAgent(defaultAgentProfiles[0].id);
    if (lead?.profile.instructions === singleBotInstructions)
      this.store.updateProfile(defaultAgentProfiles[0]);
    for (const stored of this.store.listAgents()) await this.loadAgent(stored);
    await this.recoverPendingMessages();
    for (const agent of this.agents.values()) this.schedule(agent);
  }

  close(): void {
    for (const pending of this.pendingApprovals.values()) pending.resolve(false);
    this.pendingApprovals.clear();
    this.runtime.close();
    this.store.close();
  }

  listAgents(): readonly AgentView[] {
    return [...this.agents.values()].map((agent) => this.view(agent));
  }

  botProfile(): AgentProfile {
    return this.agent(defaultAgentProfiles[0].id).profile;
  }

  async createAgent(input: CreateAgentInput): Promise<AgentView> {
    const parsed = CreateAgentInputSchema.parse(input);
    const requestedNames = [parsed.id, parsed.name].map(normalizeAgentName);
    const conflicts = [...this.agents.values()].some(({ profile }) =>
      [profile.id, ...profile.aliases].map(normalizeAgentName).some((name) => requestedNames.includes(name)),
    );
    if (conflicts) throw new Error("Bot ID or name conflicts with an existing bot or alias");
    const profile = AgentProfileSchema.parse({
      ...parsed,
      aliases: [parsed.id, parsed.name.toLowerCase()],
      sandbox: "workspace-write",
    });
    const stored = this.store.createProfile(profile);
    try {
      await this.loadAgent(stored);
      return this.view(this.agent(profile.id));
    } catch (error) {
      this.store.deleteAgent(profile.id, false);
      throw error;
    }
  }

  async deleteAgent(rawAgentId: string): Promise<void> {
    const agent = this.agent(AgentIdSchema.parse(rawAgentId));
    if (agent.profile.id === defaultAgentProfiles[0].id)
      throw new Error("The lead bot cannot be deleted");
    if (this.agents.size === 1) throw new Error("SlopBot needs at least one bot");
    if (agent.status === "running" || this.store.hasPendingMessages(agent.profile.id))
      throw new Error("Wait for bot messaging to finish before deleting it");
    this.store.deleteAgent(agent.profile.id);
    this.runtime.discardThread(agent.threadId);
    this.activeMessages.delete(agent.profile.id);
    this.agents.delete(agent.profile.id);
  }

  async updateBot(input: z.infer<typeof UpdateAgentInputSchema>): Promise<AgentProfile> {
    const agent = this.agent(defaultAgentProfiles[0].id);
    if (agent.status === "running" || this.store.hasPendingMessages(agent.profile.id))
      throw new Error("Wait for the bot to finish before editing its configuration");
    const profile = AgentProfileSchema.parse({ ...agent.profile, ...UpdateAgentInputSchema.parse(input) });
    agent.status = "running";
    try {
      this.store.updateProfile(profile);
      await this.loadAgent({ profile, threadId: agent.threadId });
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

  async redirectAgent(
    rawAgentId: string,
    text: string,
    images: readonly ImageAttachment[] = [],
  ): Promise<AgentView> {
    const parsed = UserMessageSchema.parse({ agentId: rawAgentId, text, images, skillName: null });
    const agent = this.agent(parsed.agentId);
    if (agent.status !== "running") throw new Error("The bot is not currently running");
    const message = parsed.text || "Please use this attached image as the new direction.";
    this.store.addUserMessage(agent.profile.id, message, parsed.images);
    await this.runtime.steerTurn(agent.threadId, [
      { type: "text", text: `The user redirected this work:\n\n${message}`, text_elements: [] },
      ...parsed.images.map((image) => ({ type: "image" as const, ...image })),
    ]);
    return this.view(agent);
  }

  async stopAgent(rawAgentId: string): Promise<AgentView> {
    const agent = this.agent(AgentIdSchema.parse(rawAgentId));
    const approval = this.pendingApprovals.get(agent.profile.id);
    if (approval) {
      this.pendingApprovals.delete(agent.profile.id);
      approval.resolve(false);
    }
    await this.runtime.cancelTurn(agent.threadId);
    return this.view(agent);
  }

  resolveApproval(rawAgentId: string, rawApprovalId: string, approved: boolean): AgentView {
    const agent = this.agent(AgentIdSchema.parse(rawAgentId));
    const approvalId = z.uuid().parse(rawApprovalId);
    const pending = this.pendingApprovals.get(agent.profile.id);
    if (!pending || pending.request.id !== approvalId) throw new Error("Approval request is no longer active");
    this.pendingApprovals.delete(agent.profile.id);
    pending.resolve(approved);
    return this.view(agent);
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
    this.store.setThread(agent.profile.id, threadId);
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
    this.store.setThread(stored.profile.id, threadId);
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
      dynamicTools: [sendToAgentTool, ...(desktop ? [browserTool, computerTool] : [])],
    };
  }

  private async recoverPendingMessages(): Promise<void> {
    for (const message of this.store.listProcessingMessages()) {
      const recipient = this.agents.get(message.recipientId);
      if (!recipient) {
        this.store.markFailed(message.id);
        continue;
      }
      if (
        await this.runtime.threadContainsText(recipient.threadId, message.id)
      ) {
        this.store.markCompleted(message.id);
        if (message.replyRequired && !this.store.hasReply(message.id))
          this.sendRecoveryResult(recipient, message);
      } else {
        const requeued = this.store.requeueMessage(message.id, messageRetryLimit);
        if (!requeued && message.replyRequired && !this.store.hasReply(message.id))
          this.sendRecoveryResult(recipient, message);
      }
    }
  }

  private instructionsFor(
    profile: AgentProfile,
    desktop: DesktopAssignment | null,
  ): string {
    const roster = this.teamDescription();
    const computer = desktop
      ? " The browser and computer tools target the team's shared Linux VM, not the host. Other bots and the user can see and control the same desktop, so inspect its current state before acting. Its /workspace is a shared mount; normal bash runs on the host."
      : "";
    return `You are ${profile.name} with stable bot ID ${profile.id}. ${profile.role}. ${profile.instructions} The active SlopBot team is ${roster}. Your runtime runs on ${process.platform === "darwin" ? "macOS" : process.platform}. Your host workspace is ${this.options.cwd}. The read, write, edit, grep, find, ls, and bash tools operate locally on this host.${computer} Your transcript is private. Share only deliberate handoffs through send_to_agent. A send queues a durable message and immediately returns its ID; it does not return the recipient's answer. Consequential tool calls pause for the user's approval. Do not poll, invent replies, or send receipt-only acknowledgements. Follow relevant skills and never claim an action succeeded without tool evidence.`;
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
      approval: this.pendingApprovals.get(agent.profile.id)?.request ?? null,
    };
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
    return this.computer.browser(agent.profile.id, agent.desktop.screen);
  }

  private sandboxFor(profile: AgentProfile): SandboxMode {
    return this.computer ? "danger-full-access" : profile.sandbox;
  }

  private assignDesktop(agentId: AgentId): DesktopAssignment | null {
    if (!this.computer) return null;
    return this.computer.assignment(agentId, 0);
  }

  private teamDescription(): string {
    return this.store.listAgents()
      .map(({ profile }) => `${profile.name} (${profile.id})`)
      .join(", ");
  }

  private agentByThread(threadId: string): Agent | undefined {
    return [...this.agents.values()].find(
      (agent) => agent.threadId === threadId,
    );
  }

  private agentByName(target: string, sender: Agent): Agent | undefined {
    const wanted = normalizeAgentName(target);
    return [...this.agents.values()].find(
      (agent) =>
        agent.profile.id !== sender.profile.id &&
        (normalizeAgentName(agent.profile.id) === wanted ||
          agent.profile.aliases.some(
            (alias) => normalizeAgentName(alias) === wanted,
          )),
    );
  }

  private sendAgentMessage(
    sender: Agent,
    recipient: Agent,
    text: string,
    parentId: MessageEnvelope["parentId"],
    replyRequired: boolean,
  ): MessageEnvelope {
    const message = this.store.queueMessage({
      senderId: sender.profile.id,
      recipientId: recipient.profile.id,
      parentId,
      replyRequired,
      text,
      images: [],
      skillName: null,
    });
    this.schedule(recipient);
    return message;
  }

  private schedule(agent: Agent): void {
    queueMicrotask(() => void this.runNext(agent));
  }

  private async runNext(agent: Agent): Promise<void> {
    if (agent.status === "running") return;
    const message = this.store.claimNextMessage(agent.profile.id);
    if (!message) return;

    agent.status = "running";
    const active = { message, replied: false } satisfies ActiveMessage;
    this.activeMessages.set(agent.profile.id, active);
    try {
      const skill = message.skillName
        ? this.skills.find((item) => item.name === message.skillName)
        : undefined;
      if (message.skillName && !skill)
        throw new Error(`Skill not found: ${message.skillName}`);
      const sender = message.senderId
        ? this.agent(message.senderId)
        : undefined;
      const messageText = sender
        ? message.replyRequired
          ? `SlopBot request ${message.id} from ${sender.profile.name} (${sender.profile.id}):\n\n${message.text}\n\nAct on this request. Before ending the turn, send exactly one material result to ${sender.profile.id} with send_to_agent. If there is no result, send "(pass):" followed by the reason. Do not send a receipt acknowledgement.`
          : `SlopBot result ${message.id} for request ${message.parentId ?? "unknown"} from ${sender.profile.name} (${sender.profile.id}):\n\n${message.text}\n\nAct on this result and report it to the user when relevant. Do not send a receipt acknowledgement.`
        : `SlopBot user message ${message.id}:\n\n${message.text}`;
      const text = `Active SlopBot team: ${this.teamDescription()}\n\n${messageText}`;
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
      this.ensurePeerResult(agent, active, `(failed): ${errorMessage(error)}`);
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
    if (tool === "send_to_agent") {
      const parsed = SendToAgentArgumentsSchema.safeParse(input);
      if (!parsed.success) throw new Error("target and message are required");
      const recipient = this.agentByName(parsed.data.target, sender);
      if (!recipient) {
        const available = [...this.agents.values()]
          .filter((agent) => agent.profile.id !== sender.profile.id)
          .map((agent) => `${agent.profile.name} (${agent.profile.id})`)
          .join(", ");
        throw new Error(`Agent not found. Available agents: ${available}`);
      }
      const active = this.activeMessages.get(sender.profile.id);
      const isReply = Boolean(
        active?.message.replyRequired &&
          active.message.senderId === recipient.profile.id,
      );
      if (isReply && active?.replied)
        throw new Error("A result was already sent for this request");
      const message = this.sendAgentMessage(
        sender,
        recipient,
        parsed.data.message,
        isReply ? (active?.message.id ?? null) : null,
        !isReply,
      );
      if (isReply && active) active.replied = true;
      return `Queued message ${message.id} for ${recipient.profile.name} (${recipient.profile.id}).`;
    }
    throw new Error("Unknown tool");
  }

  private async authorizeTool(threadId: ThreadId, tool: string, input: unknown): Promise<boolean> {
    const agent = this.agentByThread(threadId);
    if (!agent) throw new Error("Agent not found for approval");
    if (!this.requiresApproval(tool, input)) return true;
    if (this.pendingApprovals.has(agent.profile.id)) throw new Error("This bot already has an action awaiting approval");
    const request = ApprovalRequestSchema.parse({
      id: crypto.randomUUID(),
      tool,
      summary: this.approvalSummary(tool, input),
      requestedAt: new Date().toISOString(),
    });
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(agent.profile.id, { request, resolve });
    });
  }

  private requiresApproval(tool: string, input: unknown): boolean {
    if (["bash", "edit", "write"].includes(tool)) return true;
    if (tool !== "browser" && tool !== "computer") return false;
    if (typeof input !== "object" || input === null) return true;
    const action = Reflect.get(input, "action");
    return tool === "browser"
      ? action === "click" || action === "type" || action === "evaluate"
      : action === "click" || action === "type" || action === "key";
  }

  private approvalSummary(tool: string, input: unknown): string {
    if (typeof input === "object" && input !== null) {
      const path = Reflect.get(input, "path");
      if ((tool === "edit" || tool === "write") && typeof path === "string")
        return `${tool === "edit" ? "Edit" : "Write"} ${path}`;
      const command = Reflect.get(input, "command");
      if (tool === "bash" && typeof command === "string") return `Run: ${command.slice(0, 900)}`;
      const action = Reflect.get(input, "action");
      const detail = JSON.stringify(input);
      if (typeof action === "string") return `${tool} ${action}: ${(detail ?? "action").slice(0, 850)}`;
    }
    const detail = JSON.stringify(input);
    return `${tool}: ${(detail ?? "action").slice(0, 900)}`;
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
        this.ensurePeerResult(
          agent,
          active,
          "(pass): completed without sending a result",
        );
      } else {
        this.store.markFailed(active.message.id);
        this.ensurePeerResult(
          agent,
          active,
          `(failed): turn ended with status ${status}`,
        );
      }
      this.activeMessages.delete(agent.profile.id);
    }
    if (status === "cancelled") this.store.addAssistantMessage(agent.profile.id, "Stopped by user.");
    agent.status = status === "failed" ? "error" : "idle";
    this.schedule(agent);
  }

  private ensurePeerResult(
    agent: Agent,
    active: ActiveMessage,
    fallback: string,
  ): void {
    const senderId = active.message.senderId;
    if (!active.message.replyRequired || active.replied || !senderId) return;
    const sender = this.agents.get(senderId);
    if (!sender) return;
    this.sendAgentMessage(agent, sender, fallback, active.message.id, false);
    active.replied = true;
  }

  private sendRecoveryResult(agent: Agent, message: MessageEnvelope): void {
    const sender = message.senderId
      ? this.agents.get(message.senderId)
      : undefined;
    if (sender)
      this.sendAgentMessage(
        agent,
        sender,
        "(failed): host restarted before a result was recorded",
        message.id,
        false,
      );
  }

  private async reloadSkills(): Promise<void> {
    this.skills = (await this.runtime.listSkills()).toSorted(
      (left, right) => left.name.localeCompare(right.name),
    );
  }
}
