import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  ResourceLoader,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";

import { errorMessage, JsonObjectSchema } from "./protocol.ts";
import type { JsonObject } from "./protocol.ts";
import { SandboxModeSchema, ThreadIdSchema } from "./runtime-types.ts";
import type { ThreadId } from "./runtime-types.ts";

export const TurnIdSchema = z.string().min(1).brand<"TurnId">();
export const ApprovalPolicySchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
export const TextInputSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  text_elements: z.array(z.unknown()),
});
export const SkillInputSchema = z.object({
  type: z.literal("skill"),
  name: z.string().min(1),
  path: z.string().min(1),
});
export const TurnInputSchema = z.discriminatedUnion("type", [TextInputSchema, SkillInputSchema]);
export const DynamicToolSchema = z.object({
  type: z.literal("function"),
  name: z.string().min(1),
  description: z.string(),
  inputSchema: JsonObjectSchema,
});
export const ThreadOptionsSchema = z.object({
  cwd: z.string().min(1),
  approvalPolicy: ApprovalPolicySchema,
  sandbox: SandboxModeSchema,
  serviceName: z.string().min(1).optional(),
  developerInstructions: z.string().optional(),
  dynamicTools: z.array(DynamicToolSchema).optional(),
});
export const PiRuntimeOptionsSchema = z.object({ cwd: z.string().min(1) });
export const PiAuthStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("authenticated") }),
  z.object({ status: z.literal("unauthenticated") }),
  z.object({ status: z.literal("starting"), message: z.string() }),
  z.object({
    status: z.literal("pending"),
    verificationUri: z.url(),
    userCode: z.string().min(1),
    expiresInSeconds: z.number().positive().optional(),
  }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);

const ToolResultSchema = z.object({
  contentItems: z.array(z.object({ text: z.string() })),
  success: z.boolean(),
});

export type TurnId = z.infer<typeof TurnIdSchema>;
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export type Skill = Readonly<{
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  cwd: string;
}>;
export type TextInput = Readonly<z.infer<typeof TextInputSchema>>;
export type SkillInput = Readonly<z.infer<typeof SkillInputSchema>>;
export type TurnInput = Readonly<z.infer<typeof TurnInputSchema>>;
export type DynamicTool = Readonly<z.infer<typeof DynamicToolSchema>>;
export type ThreadOptions = Readonly<z.infer<typeof ThreadOptionsSchema>>;
export type RuntimeNotification = Readonly<{ method: string; params: unknown }>;
export type RuntimeRequest = RuntimeNotification;
export type RuntimeRequestHandler = (request: RuntimeRequest) => Promise<JsonObject>;
export type RuntimeNotificationHandler = (notification: RuntimeNotification) => void;
export type PiRuntimeOptions = Readonly<z.infer<typeof PiRuntimeOptionsSchema>>;
export type PiAuthState = Readonly<z.infer<typeof PiAuthStateSchema>>;
export { SandboxModeSchema, ThreadIdSchema } from "./runtime-types.ts";
export type { SandboxMode, ThreadId } from "./runtime-types.ts";

type ManagedSession = Readonly<{
  session: AgentSession;
  unsubscribe: () => void;
}>;

export class PiRuntime {
  private authController: AbortController | undefined;
  private authLogin: Promise<void> | undefined;
  private authState: PiAuthState = { status: "unauthenticated" };
  private readonly notifications = new Set<RuntimeNotificationHandler>();
  private readonly options: PiRuntimeOptions;
  private readonly sessions = new Map<ThreadId, ManagedSession>();
  private modelRuntime: ModelRuntime | undefined;
  private requestHandler: RuntimeRequestHandler | undefined;
  private skillLoader: ResourceLoader | undefined;

  constructor(options: PiRuntimeOptions) {
    this.options = PiRuntimeOptionsSchema.parse(options);
  }

  async connect(): Promise<void> {
    if (this.modelRuntime) return;
    this.modelRuntime = await ModelRuntime.create();
    this.skillLoader = await this.createResourceLoader(this.options.cwd);
  }

  close(): void {
    this.authController?.abort();
    for (const managed of this.sessions.values()) {
      managed.unsubscribe();
      managed.session.dispose();
    }
    this.sessions.clear();
  }

  async getAuthState(): Promise<PiAuthState> {
    if (this.authLogin) return this.authState;
    const authenticated = Boolean(await this.modelRuntime?.getAuth("openai-codex"));
    this.authState = authenticated ? { status: "authenticated" } : { status: "unauthenticated" };
    return this.authState;
  }

  async startCodexLogin(): Promise<PiAuthState> {
    if ((await this.getAuthState()).status === "authenticated" || this.authLogin) return this.authState;
    const modelRuntime = this.modelRuntime;
    if (!modelRuntime) throw new Error("Pi runtime is not connected");
    const controller = new AbortController();
    this.authController = controller;
    this.authState = { status: "starting", message: "Starting OpenAI Codex login" };
    this.authLogin = modelRuntime.login("openai-codex", "oauth", {
      signal: controller.signal,
      prompt: async (prompt) => {
        if (prompt.type === "select") {
          const device = prompt.options.find((option) => option.id.includes("device") || option.label.toLowerCase().includes("device"));
          if (device) return device.id;
        }
        throw new Error("OpenAI Codex device login requested unsupported input");
      },
      notify: (event) => {
        if (event.type === "device_code") {
          this.authState = {
            status: "pending",
            verificationUri: event.verificationUri,
            userCode: event.userCode,
            ...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}),
          };
        } else if (event.type === "progress" || event.type === "info") {
          this.authState = { status: "starting", message: event.message };
        }
      },
    }).then(
      () => { this.authState = { status: "authenticated" }; },
      (error: unknown) => { this.authState = { status: "error", message: errorMessage(error) }; },
    ).finally(() => {
      this.authController = undefined;
      this.authLogin = undefined;
    });
    return this.authState;
  }

  onNotification(handler: RuntimeNotificationHandler): () => void {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }

  handleRequests(handler: RuntimeRequestHandler): void {
    this.requestHandler = handler;
  }

  async listSkills(cwds: readonly string[], forceReload = false): Promise<readonly Skill[]> {
    const validatedCwds = z.array(z.string().min(1)).min(1).parse(cwds);
    const skills: Skill[] = [];
    for (const cwd of validatedCwds) {
      const loader = cwd === this.options.cwd && this.skillLoader
        ? this.skillLoader
        : await this.createResourceLoader(cwd);
      if (forceReload) await loader.reload();
      skills.push(...loader.getSkills().skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.filePath,
        enabled: true,
        cwd,
      })));
    }
    return skills;
  }

  async startThread(options: ThreadOptions): Promise<ThreadId> {
    const parsed = ThreadOptionsSchema.parse(options);
    return this.createSession(SessionManager.create(parsed.cwd), parsed);
  }

  async resumeThread(threadId: ThreadId, options: ThreadOptions): Promise<ThreadId> {
    const parsedId = ThreadIdSchema.parse(threadId);
    const parsed = ThreadOptionsSchema.parse(options);
    const match = (await SessionManager.list(parsed.cwd)).find((session) => session.id === parsedId);
    if (!match) throw new Error(`Pi session not found: ${parsedId}`);
    return this.createSession(SessionManager.open(match.path, undefined, parsed.cwd), parsed);
  }

  async threadContainsText(threadId: ThreadId, text: string): Promise<boolean> {
    const managed = this.sessions.get(ThreadIdSchema.parse(threadId));
    if (!managed) throw new Error(`Pi session not loaded: ${threadId}`);
    return JSON.stringify(managed.session.messages).includes(text);
  }

  async startTurn(threadId: ThreadId, input: readonly TurnInput[]): Promise<TurnId> {
    if (!await this.modelRuntime?.getAuth("openai-codex")) {
      throw new Error("Pi is not logged in to ChatGPT Plus/Pro. Run /login in Pi and choose OpenAI Codex.");
    }
    const parsedId = ThreadIdSchema.parse(threadId);
    const managed = this.sessions.get(parsedId);
    if (!managed) throw new Error(`Pi session not loaded: ${threadId}`);
    const parsedInput = z.array(TurnInputSchema).min(1).parse(input);
    const text = parsedInput.filter((item): item is TextInput => item.type === "text").map((item) => item.text).join("\n\n");
    const skill = parsedInput.find((item): item is SkillInput => item.type === "skill");
    const prompt = skill ? `/skill:${skill.name} ${text}` : text;
    const turnId = TurnIdSchema.parse(randomUUID());

    let preflightAccepted: boolean | undefined;
    let preflightError: unknown;
    let resolveAccepted: (accepted: boolean) => void = () => {};
    const accepted = new Promise<boolean>((resolve) => { resolveAccepted = resolve; });
    void managed.session.prompt(prompt, {
      preflightResult: (value) => {
        preflightAccepted = value;
        resolveAccepted(value);
      },
    }).then(
      () => {
        if (preflightAccepted) {
          this.notify({ method: "turn/completed", params: { threadId: parsedId, turn: { status: "completed" } } });
        }
      },
      (error: unknown) => {
        if (preflightAccepted !== true) {
          preflightError = error;
          resolveAccepted(false);
          return;
        }
        this.notify({
          method: "item/agentMessage/delta",
          params: { threadId: parsedId, delta: `Error: ${errorMessage(error)}` },
        });
        this.notify({ method: "turn/completed", params: { threadId: parsedId, turn: { status: "failed" } } });
      },
    );
    if (!await accepted) {
      throw new Error(preflightError === undefined ? "Pi rejected the prompt" : errorMessage(preflightError));
    }
    return turnId;
  }

  private async createSession(sessionManager: SessionManager, options: ThreadOptions): Promise<ThreadId> {
    const modelRuntime = this.modelRuntime;
    if (!modelRuntime) throw new Error("Pi runtime is not connected");
    const model = modelRuntime.getModel("openai-codex", "gpt-5.6-sol");
    if (!model) throw new Error("Pi has no OpenAI Codex gpt-5.6-sol model");
    const threadId = ThreadIdSchema.parse(sessionManager.getSessionId());
    const resourceLoader = await this.createResourceLoader(options.cwd, options.developerInstructions);
    const customTools = (options.dynamicTools ?? []).map((tool) => this.customTool(tool, threadId));
    const builtInTools = options.sandbox === "read-only"
      ? ["read", "grep", "find", "ls"]
      : ["read", "bash", "edit", "write", "grep", "find", "ls"];
    const { session } = await createAgentSession({
      cwd: options.cwd,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      thinkingLevel: "high",
      tools: [...builtInTools, ...customTools.map((tool) => tool.name)],
      customTools,
    });
    const unsubscribe = session.subscribe((event) => this.handleSessionEvent(threadId, event));
    this.sessions.set(threadId, { session, unsubscribe });
    return threadId;
  }

  private async createResourceLoader(cwd: string, instructions?: string): Promise<ResourceLoader> {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      ...(instructions ? { appendSystemPrompt: [instructions] } : {}),
    });
    await loader.reload();
    return loader;
  }

  private customTool(tool: DynamicTool, threadId: ThreadId): ToolDefinition {
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      execute: async (_toolCallId, params) => {
        if (!this.requestHandler) throw new Error(`No handler registered for ${tool.name}`);
        const rawResult = await this.requestHandler({
          method: "item/tool/call",
          params: { tool: tool.name, threadId, arguments: params },
        });
        const result = ToolResultSchema.parse(rawResult);
        const text = result.contentItems.map((item) => item.text).join("\n");
        if (!result.success) throw new Error(text);
        return { content: [{ type: "text", text }], details: {} };
      },
    };
  }

  private handleSessionEvent(threadId: ThreadId, event: AgentSessionEvent): void {
    if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
    this.notify({
      method: "item/agentMessage/delta",
      params: { threadId, delta: event.assistantMessageEvent.delta },
    });
  }

  private notify(notification: RuntimeNotification): void {
    for (const handler of this.notifications) handler(notification);
  }
}
