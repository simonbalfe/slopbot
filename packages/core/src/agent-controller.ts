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
const PassReplySchema = z.object({
  senderId: AgentIdSchema,
  recipientId: AgentIdSchema,
});
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
export type AgentControllerErrorCode =
  | "agent-not-found"
  | "skill-not-found"
  | "no-reply"
  | "agent-running"
  | "browser-unavailable";

type Agent = Readonly<{
  profile: AgentProfile;
  threadId: ThreadId;
  desktop: DesktopAssignment | null;
}> & { status: AgentStatus };

export class AgentControllerError extends Error {
  constructor(
    readonly code: AgentControllerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

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
    try {
      this.runtime.handleRequests((request) =>
        this.handleRuntimeRequest(request),
      );
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
    } catch (error) {
      this.computer?.close();
      throw error;
    }
  }

  close(): void {
    this.runtime.close();
    this.computer?.close();
    this.store.close();
  }

  listAgents(): readonly AgentView[] {
    return [...this.agents.values()].map((agent) => this.view(agent));
  }

  listSkills(): readonly Skill[] {
    return this.skills;
  }

  async createAgent(profile: AgentProfile): Promise<AgentView> {
    const validated = AgentProfileSchema.parse(profile);
    if (this.agents.has(validated.id) || this.store.getAgent(validated.id)) {
      throw new Error(`Agent already exists: ${validated.id}`);
    }
    this.store.upsertProfiles([validated]);
    const desktop = this.assignDesktop(validated.id);
    const options = this.threadOptions(validated, desktop);
    const threadConfig = this.threadConfig(options);
    const threadId = await this.runtime.startThread(options);
    this.store.saveAgent(validated, threadId, threadConfig);
    const agent = {
      profile: validated,
      threadId,
      desktop,
      status: "idle",
    } satisfies Agent;
    this.agents.set(validated.id, agent);
    this.activeAgentIds.add(validated.id);
    return this.view(agent);
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
      throw new AgentControllerError("skill-not-found", "Skill not found");
    const message = this.store.queueMessage({
      senderId: null,
      recipientId: agent.profile.id,
      text: parsed.text,
      skillName: parsed.skillName ?? null,
    });
    this.schedule(agent);
    return message;
  }

  passReply(rawSenderId: string, rawRecipientId: string): MessageEnvelope {
    const { recipientId, senderId } = PassReplySchema.parse({
      senderId: rawSenderId,
      recipientId: rawRecipientId,
    });
    const sender = this.agent(senderId);
    const recipient = this.agent(recipientId);
    const reply = this.store.lastAssistantMessage(sender.profile.id);
    if (!reply)
      throw new AgentControllerError("no-reply", "There is no reply to pass");
    return this.sendAgentMessage(sender, recipient, reply.text);
  }

  async clearChat(rawAgentId: string): Promise<AgentView> {
    const agent = this.agent(AgentIdSchema.parse(rawAgentId));
    if (agent.status === "running") {
      throw new AgentControllerError(
        "agent-running",
        "Wait for the agent to finish before clearing its chat",
      );
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
        this.store.markDelivered(message.id, null);
      } else {
        this.store.requeueMessage(message.id);
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
      ? " You have a dedicated Agent Infra sandbox browser. Control it only with the browser tool."
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
      throw new AgentControllerError("agent-not-found", "Agent not found");
    return agent;
  }

  private browser(rawAgentId: string): SandboxBrowser {
    const agent = this.agent(AgentIdSchema.parse(rawAgentId));
    if (!agent.desktop || !this.computer)
      throw new AgentControllerError(
        "browser-unavailable",
        "Browser access is unavailable",
      );
    return this.computer.browser(agent.desktop.screen);
  }

  private sandboxFor(profile: AgentProfile): SandboxMode {
    // ponytail: the container is the sandbox; add per-agent containers when filesystem isolation is required.
    return this.computer ? "danger-full-access" : profile.sandbox;
  }

  private assignDesktop(agentId: AgentId): DesktopAssignment | null {
    if (!this.computer) return null;
    const screen = this.store.assignDesktop(agentId, this.computer.screenCount);
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
  ): MessageEnvelope {
    const message = this.store.queueMessage({
      senderId: sender.profile.id,
      recipientId: recipient.profile.id,
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
    try {
      const skill = message.skillName
        ? this.skills.find((item) => item.name === message.skillName)
        : undefined;
      if (message.skillName && !skill)
        throw new AgentControllerError(
          "skill-not-found",
          `Skill not found: ${message.skillName}`,
        );
      const sender = message.senderId
        ? this.agent(message.senderId)
        : undefined;
      const text = sender
        ? `SlopBot message ${message.id} from ${sender.profile.name} (${sender.profile.id}):\n\n${message.text}\n\nAct on this message. Reply with send_to_agent only when you have a material result. Do not send a receipt acknowledgement.`
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
      this.store.markDelivered(message.id, turnId);
    } catch (error) {
      this.store.markFailed(message.id);
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

    const message = this.sendAgentMessage(
      sender,
      recipient,
      parsedArguments.data.message,
    );
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
      agent.status = parsed.data.turn.status === "completed" ? "idle" : "error";
      this.schedule(agent);
    }
  }

  private async reloadSkills(forceReload: boolean): Promise<void> {
    this.skills = (
      await this.runtime.listSkills([this.options.cwd], forceReload)
    )
      .filter((skill) => skill.enabled)
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}
