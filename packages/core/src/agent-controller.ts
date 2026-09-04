import { createHash } from "node:crypto";
import { z } from "zod";

import { AgentStore } from "./agent-store.ts";
import type { StoredAgent } from "./agent-store.ts";
import {
  AgentIdSchema,
  AgentProfileSchema,
  createAgentId,
} from "./agent-types.ts";
import type {
  AgentId,
  AgentProfile,
  AgentStatus,
  AgentView,
  DesktopAssignment,
  MessageEnvelope,
} from "./agent-types.ts";
import {
  BrowserArgumentsSchema,
  BrowserInputSchema,
} from "./sandbox-browser.ts";
import type { SandboxBrowser } from "./sandbox-browser.ts";
import { PiRuntime } from "./pi-runtime.ts";
import type {
  DynamicTool,
  CreateSkillInput,
  RuntimeNotification,
  SandboxMode,
  Skill,
  ThreadId,
  ThreadOptions,
  TurnInput,
} from "./pi-runtime.ts";
import { errorMessage, textSchema } from "./protocol.ts";
import type { JsonObject } from "./protocol.ts";
import {
  SandboxComputer,
  SandboxComputerOptionsSchema,
} from "./sandbox-computer.ts";

export const AgentControllerOptionsSchema = z.object({
  cwd: z.string().min(1),
  databasePath: z.string().min(1),
  computer: SandboxComputerOptionsSchema.optional(),
});
const UserMessageSchema = z.object({
  agentId: AgentIdSchema,
  text: textSchema(8_000),
  skillName: textSchema(100).nullish(),
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
export type CreateAgentInput = Readonly<z.infer<typeof CreateAgentInputSchema>>;
const ToolRequestSchema = z.object({
  tool: z.string(),
  threadId: z.string(),
  arguments: z.unknown(),
});
const SendToAgentArgumentsSchema = z.object({
  target: textSchema(50),
  message: textSchema(8_000),
});
const AgentMessageDeltaSchema = z.object({
  threadId: z.string(),
  delta: z.string(),
});
const TurnCompletedSchema = z.object({
  threadId: z.string(),
  turn: z.object({ status: z.string() }),
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
  replied: boolean;
};

const messageRetryLimit = 3;

export const defaultAgentProfiles = [
  {
    id: createAgentId("lead"),
    name: "LEAD",
    aliases: ["lead", "manager"],
    role: "Routes work and owns the final answer",
    sandbox: "read-only",
    instructions:
      "Own intake, delegation, and synthesis. Send execution to WORKER and report only results the worker actually returns.",
  },
  {
    id: createAgentId("worker"),
    name: "WORKER",
    aliases: ["worker", "researcher", "builder", "reviewer", "ops"],
    role: "Researches, builds, reviews, and operates",
    sandbox: "workspace-write",
    instructions:
      "Inspect the real flow, gather evidence, implement the smallest root-cause change, and verify it. Preserve unrelated work. Use the assigned browser and relevant skills or CLI tools when needed. Send material results and remaining risks to LEAD.",
  },
] satisfies readonly AgentProfile[];

const retiredDefaultAgentIds = ["research", "build", "review", "ops"].map(
  createAgentId,
);

const sendToAgentTool = {
  type: "function",
  name: "send_to_agent",
  description:
    "Queue an asynchronous message to another agent and return a delivery acknowledgement with a stable message ID.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "Target agent ID or name" },
      message: { type: "string", description: "Concise message or handoff" },
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

function normalizeAgentName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+agent$/, "");
}

function toolResult(text: string, success: boolean): JsonObject {
  return { contentItems: [{ type: "inputText", text }], success };
}

export class AgentController {
  private readonly agents = new Map<AgentId, Agent>();
  private readonly activeMessages = new Map<AgentId, ActiveMessage>();
  private readonly activeAgentIds = new Set<AgentId>();
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

  async initialize(
    profiles: readonly AgentProfile[] = defaultAgentProfiles,
  ): Promise<void> {
    await this.computer?.start();
    this.runtime.handleRequests((request) => this.handleRuntimeRequest(request));
    this.runtime.onNotification((notification) =>
      this.handleNotification(notification),
    );
    await this.runtime.connect();
    await this.reloadSkills(true);
    this.store.upsertProfiles(profiles);
    this.store.releaseDesktops(retiredDefaultAgentIds);

    const profileIds = new Set(profiles.map((profile) => profile.id));
    const storedAgents = [
      ...profiles.flatMap((profile) => {
        const stored = this.store.getAgent(profile.id);
        return stored ? [stored] : [];
      }),
      ...this.store
        .listAgents()
        .filter(
          ({ profile }) =>
            !profileIds.has(profile.id) &&
            !retiredDefaultAgentIds.includes(profile.id),
        ),
    ];
    for (const { profile } of storedAgents)
      this.activeAgentIds.add(profile.id);
    for (const stored of storedAgents) await this.loadAgent(stored);
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

  listSkills(): readonly Skill[] {
    return this.skills;
  }

  async createAgent(input: CreateAgentInput): Promise<AgentView> {
    const parsed = CreateAgentInputSchema.parse(input);
    const profile = AgentProfileSchema.parse({
      ...parsed,
      aliases: [parsed.id, parsed.name.toLowerCase()],
      sandbox: "workspace-write",
    });
    const stored = this.store.createProfile(profile);
    this.activeAgentIds.add(profile.id);
    try {
      await this.loadAgent(stored);
      return this.view(this.agent(profile.id));
    } catch (error) {
      this.activeAgentIds.delete(profile.id);
      this.store.deleteAgent(profile.id, false);
      throw error;
    }
  }

  async deleteAgent(rawAgentId: string): Promise<void> {
    const agent = this.agent(AgentIdSchema.parse(rawAgentId));
    if (this.agents.size === 1) throw new Error("SlopBot needs at least one bot");
    if (agent.status === "running" || this.store.hasPendingMessages(agent.profile.id))
      throw new Error("Wait for bot messaging to finish before deleting it");
    this.store.deleteAgent(agent.profile.id);
    this.runtime.discardThread(agent.threadId);
    this.activeMessages.delete(agent.profile.id);
    this.activeAgentIds.delete(agent.profile.id);
    this.agents.delete(agent.profile.id);
  }

  async createSkill(input: CreateSkillInput): Promise<Skill> {
    const created = await this.runtime.createSkill(input);
    await this.reloadSkills(true);
    const skill = this.skills.find((item) => item.name === created.name);
    if (!skill) throw new Error("Skill was not created");
    return skill;
  }

  sendMessage(
    rawAgentId: string,
    text: string,
    skillName?: string,
  ): MessageEnvelope {
    const parsed = UserMessageSchema.parse({
      agentId: rawAgentId,
      text,
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
      text: parsed.text,
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
    if (stored.threadConfig !== threadConfig) threadId = null;
    if (threadId && stored.threadConfig === threadConfig) {
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
      this.store.setThread(stored.profile.id, threadId, threadConfig);
    }
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
      dynamicTools: [sendToAgentTool, ...(desktop ? [browserTool] : [])],
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
        this.store.requeueMessage(message.id, messageRetryLimit);
      }
    }
  }

  private instructionsFor(
    profile: AgentProfile,
    desktop: DesktopAssignment | null,
  ): string {
    const roster = this.store
      .listAgents()
      .filter(({ profile: teammate }) => this.activeAgentIds.has(teammate.id))
      .map(({ profile: teammate }) => `${teammate.name} (${teammate.id})`)
      .join(", ");
    const computer = desktop
      ? " You have a dedicated SlopBot browser runtime. Control it only with the browser tool."
      : "";
    return `You are ${profile.name} with stable agent ID ${profile.id}. ${profile.role}. ${profile.instructions} The team is ${roster}.${computer} Your transcript is private. Share only deliberate handoffs. When a skill is attached, follow its SKILL.md and use Pi's shell tool for any CLI it requires. Never claim a command ran without tool output. For SlopBot teammates, use only send_to_agent, never collaboration tools or live agent paths. A send queues a durable message and immediately returns its message ID, never the recipient's reply. Do not poll, invent replies, or send receipt-only acknowledgements.`;
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
    // ponytail: the container is the sandbox; add per-agent containers when filesystem isolation is required.
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

  private agentByName(target: string, sender: Agent): Agent | undefined {
    const wanted = normalizeAgentName(target);
    return [...this.agents.values()].find(
      (agent) =>
        agent.profile.id !== sender.profile.id &&
        (agent.profile.id === target ||
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
      const text = sender
        ? message.replyRequired
          ? `SlopBot request ${message.id} from ${sender.profile.name} (${sender.profile.id}):\n\n${message.text}\n\nAct on this request. Before ending the turn, send exactly one material result to ${sender.profile.id} with send_to_agent. If there is no result, send \"(pass):\" followed by the reason. Do not send a receipt acknowledgement.`
          : `SlopBot result ${message.id} for request ${message.parentId ?? "unknown"} from ${sender.profile.name} (${sender.profile.id}):\n\n${message.text}\n\nAct on this result and report it to the user when relevant. Do not send a receipt acknowledgement.`
        : `SlopBot user message ${message.id}:\n\n${message.text}`;
      const input: TurnInput[] = [
        {
          type: "text",
          text,
          text_elements: [],
        },
      ];
      if (skill)
        input.push({ type: "skill", name: skill.name, path: skill.path });
      const turnId = await this.runtime.startTurn(agent.threadId, input);
      this.store.setTurn(message.id, turnId);
    } catch (error) {
      this.store.markFailed(message.id);
      this.ensurePeerResult(
        agent,
        active,
        `(failed): ${errorMessage(error)}`,
      );
      this.activeMessages.delete(agent.profile.id);
      this.store.addAssistantMessage(
        agent.profile.id,
        `Error: ${errorMessage(error)}`,
      );
      agent.status = "error";
    }
  }

  private async handleRuntimeRequest(
    request: RuntimeNotification,
  ): Promise<JsonObject> {
    if (request.method !== "item/tool/call")
      throw new Error(`Unsupported server request: ${request.method}`);
    const parsedRequest = ToolRequestSchema.safeParse(request.params);
    if (!parsedRequest.success)
      return toolResult("Invalid tool request", false);
    const sender = this.agentByThread(parsedRequest.data.threadId);
    if (!sender) return toolResult("Sender agent not found", false);
    if (parsedRequest.data.tool === "browser") {
      return this.handleBrowserRequest(sender, parsedRequest.data.arguments);
    }
    if (parsedRequest.data.tool !== "send_to_agent")
      return toolResult("Unknown tool", false);
    const parsedArguments = SendToAgentArgumentsSchema.safeParse(
      parsedRequest.data.arguments,
    );
    if (!parsedArguments.success)
      return toolResult("target and message are required", false);
    const recipient = this.agentByName(parsedArguments.data.target, sender);
    if (!recipient) {
      const available = [...this.agents.values()]
        .filter((agent) => agent.profile.id !== sender.profile.id)
        .map((agent) => `${agent.profile.name} (${agent.profile.id})`)
        .join(", ");
      return toolResult(
        `Agent not found. Available agents: ${available}`,
        false,
      );
    }

    const active = this.activeMessages.get(sender.profile.id);
    const isReply = Boolean(
      active?.message.replyRequired &&
        active.message.senderId === recipient.profile.id,
    );
    if (isReply && active?.replied)
      return toolResult("A result was already sent for this request", false);
    const message = this.sendAgentMessage(
      sender,
      recipient,
      parsedArguments.data.message,
      isReply ? (active?.message.id ?? null) : null,
      !isReply,
    );
    if (isReply && active) active.replied = true;
    return toolResult(
      `Queued message ${message.id} for ${recipient.profile.name} (${recipient.profile.id}).`,
      true,
    );
  }

  private async handleBrowserRequest(
    agent: Agent,
    rawArguments: unknown,
  ): Promise<JsonObject> {
    if (!agent.desktop)
      return toolResult("Browser access is unavailable", false);
    const parsedArguments = BrowserArgumentsSchema.safeParse(rawArguments);
    if (!parsedArguments.success)
      return toolResult("Invalid browser request", false);
    try {
      return toolResult(
        await this.browser(agent.profile.id).execute(parsedArguments.data),
        true,
      );
    } catch (error) {
      return toolResult(errorMessage(error), false);
    }
  }

  private handleNotification(notification: RuntimeNotification): void {
    if (notification.method === "skills/changed") {
      void this.reloadSkills(true).catch((error: unknown) =>
        console.error(`Skill reload failed: ${errorMessage(error)}`),
      );
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      const parsed = AgentMessageDeltaSchema.safeParse(notification.params);
      if (!parsed.success) return;
      const agent = this.agentByThread(parsed.data.threadId);
      if (!agent) return;
      const last = this.store.lastMessage(agent.profile.id);
      if (last?.role === "assistant")
        this.store.updateMessageText(last.id, last.text + parsed.data.delta);
      else this.store.addAssistantMessage(agent.profile.id, parsed.data.delta);
      return;
    }

    if (notification.method === "turn/completed") {
      const parsed = TurnCompletedSchema.safeParse(notification.params);
      if (!parsed.success) return;
      const agent = this.agentByThread(parsed.data.threadId);
      if (!agent) return;
      const active = this.activeMessages.get(agent.profile.id);
      if (active) {
        if (parsed.data.turn.status === "completed") {
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
            `(failed): turn ended with status ${parsed.data.turn.status}`,
          );
        }
        this.activeMessages.delete(agent.profile.id);
      }
      agent.status = parsed.data.turn.status === "completed" ? "idle" : "error";
      this.schedule(agent);
    }
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

  private async reloadSkills(forceReload: boolean): Promise<void> {
    this.skills = (
      await this.runtime.listSkills([this.options.cwd], forceReload)
    )
      .filter((skill) => skill.enabled)
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}
