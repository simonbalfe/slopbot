import { randomUUID } from "node:crypto";
import { z } from "zod";

import { CodexAppServer } from "./codex-app-server.ts";
import { SandboxModeSchema } from "./codex-app-server.ts";
import type { AppServerNotification, DynamicTool, SandboxMode, Skill, ThreadId, TurnInput } from "./codex-app-server.ts";
import { errorMessage, textSchema } from "./protocol.ts";
import type { JsonObject } from "./protocol.ts";

export const AgentIdSchema = textSchema(100).brand<"AgentId">();
export const AgentProfileSchema = z.object({
  id: AgentIdSchema,
  name: textSchema(50),
  aliases: z.array(textSchema(50)).min(1),
  role: textSchema(200),
  sandbox: SandboxModeSchema,
  instructions: textSchema(2_000),
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
const AgentMessageDeltaSchema = z.object({ threadId: z.string(), delta: z.string() });
const TurnCompletedSchema = z.object({
  threadId: z.string(),
  turn: z.object({ status: z.string() }),
});

export type AgentId = z.infer<typeof AgentIdSchema>;
export type AgentStatus = "idle" | "running" | "error";
export type AgentProfile = Readonly<z.infer<typeof AgentProfileSchema>>;

export type AgentMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  text: string;
}>;

export type AgentView = Readonly<{
  id: AgentId;
  name: string;
  role: string;
  sandbox: SandboxMode;
  threadId: ThreadId;
  messages: readonly AgentMessage[];
  status: AgentStatus;
}>;

type Task = Readonly<{
  text: string;
  skill: Skill | undefined;
}>;

type Agent = AgentProfile & {
  readonly threadId: ThreadId;
  readonly messages: AgentMessage[];
  readonly queue: Task[];
  status: AgentStatus;
};

export type AgentControllerErrorCode = "agent-not-found" | "skill-not-found" | "no-reply";

export class AgentControllerError extends Error {
  constructor(readonly code: AgentControllerErrorCode, message: string) {
    super(message);
  }
}

export function createAgentId(value: string): AgentId {
  return AgentIdSchema.parse(value);
}

export const defaultAgentProfiles = [
  {
    id: createAgentId("lead"),
    name: "LEAD",
    aliases: ["lead", "manager"],
    role: "Routes work and owns the final answer",
    sandbox: "read-only",
    instructions: "Own intake, decomposition, delegation, and synthesis. Send evidence work to RESEARCH, implementation to BUILD, verification to REVIEW, and runtime or CLI operations to OPS. Report only results that teammates actually return.",
  },
  {
    id: createAgentId("research"),
    name: "RESEARCH",
    aliases: ["research", "researcher"],
    role: "Finds repository-grounded evidence",
    sandbox: "read-only",
    instructions: "Gather facts from primary sources and the live repository. Separate evidence from inference. Return compact handoffs containing goal, state, evidence, constraints, and next action. Do not implement unless explicitly asked.",
  },
  {
    id: createAgentId("build"),
    name: "BUILD",
    aliases: ["build", "builder"],
    role: "Implements the smallest working change",
    sandbox: "workspace-write",
    instructions: "Inspect the real flow, implement the smallest root-cause change, and verify it. Preserve unrelated work. Send completed changes and test evidence to REVIEW, then report the result to LEAD.",
  },
  {
    id: createAgentId("review"),
    name: "REVIEW",
    aliases: ["review", "reviewer"],
    role: "Independently tests and challenges work",
    sandbox: "read-only",
    instructions: "Review source and behavior independently. Prioritize correctness, regressions, security, and missing tests. Do not edit unless explicitly asked. Send actionable findings to BUILD and a clear verdict to LEAD.",
  },
  {
    id: createAgentId("ops"),
    name: "OPS",
    aliases: ["ops", "operations"],
    role: "Runs services and operational CLI workflows",
    sandbox: "workspace-write",
    instructions: "Operate and diagnose services with the relevant skill and CLI. Prefer read-only checks. Perform external or destructive actions only when the user explicitly requested them. Report commands, evidence, and outcomes to LEAD.",
  },
] satisfies readonly AgentProfile[];

const sendToAgentTool = {
  type: "function",
  name: "send_to_agent",
  description: "Send an asynchronous message to another agent when the user asks to tell, pass, delegate, or share something.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "Target agent name" },
      message: { type: "string", description: "Concise message or handoff" },
    },
    required: ["target", "message"],
    additionalProperties: false,
  },
} satisfies DynamicTool;

function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+agent$/, "");
}

function toolResult(text: string, success: boolean): JsonObject {
  return { contentItems: [{ type: "inputText", text }], success };
}

export class AgentController {
  private readonly agents = new Map<AgentId, Agent>();
  private skills: readonly Skill[] = [];

  constructor(private readonly client: CodexAppServer, private readonly cwd: string) {}

  async initialize(profiles: readonly AgentProfile[] = defaultAgentProfiles): Promise<void> {
    this.client.handleRequests((request) => this.handleServerRequest(request));
    this.client.onNotification((notification) => this.handleNotification(notification));
    await this.client.connect();
    await this.reloadSkills(true);
    for (const profile of profiles) await this.createAgent(profile);
  }

  listAgents(): readonly AgentView[] {
    return [...this.agents.values()].map((agent) => this.view(agent));
  }

  listSkills(): readonly Skill[] {
    return this.skills;
  }

  async createAgent(profile: AgentProfile): Promise<AgentView> {
    const validatedProfile = AgentProfileSchema.parse(profile);
    if (this.agents.has(validatedProfile.id)) throw new Error(`Agent already exists: ${validatedProfile.id}`);
    const threadId = await this.client.startThread({
      cwd: this.cwd,
      approvalPolicy: "never",
      sandbox: validatedProfile.sandbox,
      serviceName: "openbot",
      developerInstructions: this.instructionsFor(validatedProfile),
      dynamicTools: [sendToAgentTool],
    });
    const agent: Agent = { ...validatedProfile, threadId, messages: [], queue: [], status: "idle" };
    this.agents.set(agent.id, agent);
    return this.view(agent);
  }

  sendMessage(rawAgentId: string, text: string, skillName?: string): void {
    const agent = this.findAgent(rawAgentId);
    if (!agent) throw new AgentControllerError("agent-not-found", "Agent not found");
    const skill = skillName ? this.skills.find((item) => item.name === skillName) : undefined;
    if (skillName && !skill) throw new AgentControllerError("skill-not-found", "Skill not found");
    this.enqueue(agent, text, skill);
  }

  passReply(rawSenderId: string, rawRecipientId: string): void {
    const sender = this.findAgent(rawSenderId);
    const recipient = this.findAgent(rawRecipientId);
    if (!sender || !recipient) throw new AgentControllerError("agent-not-found", "Agent not found");
    const reply = sender.messages.findLast((message) => message.role === "assistant");
    if (!reply) throw new AgentControllerError("no-reply", "There is no reply to pass");
    this.enqueue(recipient, `Handoff from ${sender.name} (${sender.role}):\n\n${reply.text}`);
  }

  private instructionsFor(profile: AgentProfile): string {
    return `You are ${profile.name}. ${profile.role}. ${profile.instructions} The team is LEAD, RESEARCH, BUILD, REVIEW, and OPS. Your transcript is private. Share only deliberate handoffs. When a skill is attached, follow its SKILL.md and use Codex's native shell tool for any CLI it requires. Never claim a command ran without tool output. When asked to tell, pass, delegate, or share something with another agent, call send_to_agent. A send is fire-and-forget: acknowledge delivery but never invent the recipient's reply or poll for it. Use send_to_agent for material replies to teammate messages, but do not create acknowledgement loops.`;
  }

  private view({ id, name, role, sandbox, threadId, messages, status }: Agent): AgentView {
    return { id, name, role, sandbox, threadId, messages, status };
  }

  private async reloadSkills(forceReload: boolean): Promise<void> {
    this.skills = (await this.client.listSkills([this.cwd], forceReload))
      .filter((skill) => skill.enabled)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private findAgent(rawAgentId: string): Agent | undefined {
    return [...this.agents.values()].find((agent) => agent.id === rawAgentId);
  }

  private agentByThread(threadId: string): Agent | undefined {
    return [...this.agents.values()].find((agent) => agent.threadId === threadId);
  }

  private agentByName(target: string, sender: Agent): Agent | undefined {
    const wanted = normalizeAgentName(target);
    return [...this.agents.values()].find(
      (agent) => agent.id !== sender.id && agent.aliases.some((alias) => normalizeAgentName(alias) === wanted),
    );
  }

  private enqueue(agent: Agent, text: string, skill?: Skill): void {
    agent.messages.push({ id: randomUUID(), role: "user", text: skill ? `$${skill.name}\n${text}` : text });
    agent.queue.push({ text, skill });
    void this.runNext(agent);
  }

  private async runNext(agent: Agent): Promise<void> {
    if (agent.status === "running") return;
    const task = agent.queue.shift();
    if (!task) return;

    agent.status = "running";
    try {
      const input: TurnInput[] = [{
        type: "text",
        text: task.skill ? `$${task.skill.name} ${task.text}` : task.text,
        text_elements: [],
      }];
      if (task.skill) input.push({ type: "skill", name: task.skill.name, path: task.skill.path });
      await this.client.startTurn(agent.threadId, input);
    } catch (error) {
      agent.status = "error";
      agent.messages.push({ id: randomUUID(), role: "assistant", text: `Error: ${errorMessage(error)}` });
    }
  }

  private async handleServerRequest(request: AppServerNotification): Promise<JsonObject> {
    if (request.method !== "item/tool/call") throw new Error(`Unsupported server request: ${request.method}`);
    const parsedRequest = ToolRequestSchema.safeParse(request.params);
    if (!parsedRequest.success) return toolResult("Invalid tool request", false);
    if (parsedRequest.data.tool !== "send_to_agent") return toolResult("Unknown tool", false);
    const parsedArguments = SendToAgentArgumentsSchema.safeParse(parsedRequest.data.arguments);
    if (!parsedArguments.success) return toolResult("target and message are required", false);

    const sender = this.agentByThread(parsedRequest.data.threadId);
    if (!sender) return toolResult("Sender agent not found", false);
    const { message: text, target } = parsedArguments.data;

    const recipient = this.agentByName(target, sender);
    if (!recipient) {
      const available = [...this.agents.values()].filter((agent) => agent.id !== sender.id).map((agent) => agent.name).join(", ");
      return toolResult(`Agent not found. Available agents: ${available}`, false);
    }

    this.enqueue(recipient, `Teammate message from ${sender.name} (${sender.role}):\n\n${text}\n\nAct on this message. If ${sender.name} needs a material result, use send_to_agent to return it. Do not send receipt-only acknowledgements.`);
    return toolResult(`Delivered to ${recipient.name}. The recipient was queued and will run independently.`, true);
  }

  private handleNotification(notification: AppServerNotification): void {
    if (notification.method === "skills/changed") {
      void this.reloadSkills(true).catch((error: unknown) => console.error(`Skill reload failed: ${errorMessage(error)}`));
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      const parsed = AgentMessageDeltaSchema.safeParse(notification.params);
      if (!parsed.success) return;
      const agent = this.agentByThread(parsed.data.threadId);
      if (!agent) return;
      const { delta } = parsed.data;
      const last = agent.messages.at(-1);
      if (last?.role === "assistant") agent.messages[agent.messages.length - 1] = { ...last, text: last.text + delta };
      else agent.messages.push({ id: randomUUID(), role: "assistant", text: delta });
      return;
    }

    if (notification.method === "turn/completed") {
      const parsed = TurnCompletedSchema.safeParse(notification.params);
      if (!parsed.success) return;
      const agent = this.agentByThread(parsed.data.threadId);
      if (!agent) return;
      agent.status = parsed.data.turn.status === "completed" ? "idle" : "error";
      void this.runNext(agent);
    }
  }
}

// ponytail: agent state resets on restart; add SQLite when durable coordination is actually needed.
