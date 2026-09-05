import { nousProvider, nousModels } from "./nous-provider.ts";
import { ModelSelectionSchema } from "./agent-types.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

import { ImageAttachmentSchema } from "./agent-types.ts";
import type { ImageAttachment } from "./agent-types.ts";
import { errorMessage, JsonObjectSchema } from "./protocol.ts";
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
export const ImageInputSchema = ImageAttachmentSchema.extend({
  type: z.literal("image"),
});
export const TurnInputSchema = z.discriminatedUnion("type", [
  TextInputSchema,
  SkillInputSchema,
  ImageInputSchema,
]);
export const DynamicToolSchema = z.object({
  type: z.literal("function"),
  name: z.string().min(1),
  description: z.string(),
  inputSchema: JsonObjectSchema,
});
export const ThreadOptionsSchema = z.object({
  cwd: z.string().min(1),
  ...ModelSelectionSchema.shape,
  approvalPolicy: ApprovalPolicySchema,
  sandbox: SandboxModeSchema,
  serviceName: z.string().min(1).optional(),
  developerInstructions: z.string().optional(),
  dynamicTools: z.array(DynamicToolSchema).optional(),
});
export const PiRuntimeOptionsSchema = z.object({ cwd: z.string().min(1) });
export const CreateSkillInputSchema = z.object({
  name: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(500),
  content: z.string().trim().min(1).max(20_000),
});
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

export type TurnId = z.infer<typeof TurnIdSchema>;
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export type Skill = Readonly<{
  name: string;
  description: string;
  content: string;
  path: string;
}>;
export type TextInput = Readonly<z.infer<typeof TextInputSchema>>;
export type SkillInput = Readonly<z.infer<typeof SkillInputSchema>>;
export type ImageInput = Readonly<z.infer<typeof ImageInputSchema>>;
export type TurnInput = Readonly<z.infer<typeof TurnInputSchema>>;
export type DynamicTool = Readonly<z.infer<typeof DynamicToolSchema>>;
export type ThreadOptions = Readonly<z.infer<typeof ThreadOptionsSchema>>;
export type TurnStatus = "completed" | "failed";
export type PiRuntimeOptions = Readonly<z.infer<typeof PiRuntimeOptionsSchema>>;
export type CreateSkillInput = Readonly<z.infer<typeof CreateSkillInputSchema>>;
export type PiAuthState = Readonly<z.infer<typeof PiAuthStateSchema>>;
export { SandboxModeSchema, ThreadIdSchema } from "./runtime-types.ts";
export type { SandboxMode, ThreadId } from "./runtime-types.ts";

type ManagedSession = Readonly<{
  session: AgentSession;
  unsubscribe: () => void;
  options: ThreadOptions;
}>;

export class PiRuntime {
  private authController: AbortController | undefined;
  private authLogin: Promise<void> | undefined;
  private authState: PiAuthState = { status: "unauthenticated" };
  onText: ((threadId: ThreadId, delta: string) => void) | undefined;
  onTurnComplete: ((threadId: ThreadId, status: TurnStatus) => void) | undefined;
  onToolCall: ((threadId: ThreadId, tool: string, input: unknown) => Promise<string | ImageAttachment>) | undefined;
  private readonly options: PiRuntimeOptions;
  private readonly sessions = new Map<ThreadId, ManagedSession>();
  private modelRuntime: ModelRuntime | undefined;
  private skillLoader: ResourceLoader | undefined;

  constructor(options: PiRuntimeOptions) {
    this.options = PiRuntimeOptionsSchema.parse(options);
  }

  async connect(): Promise<void> {
    if (this.modelRuntime) return;
    this.modelRuntime = await ModelRuntime.create();
    this.modelRuntime.registerProvider("nous", nousProvider(process.env["SLOPBOT_NOUS_CLIENT_ID"]));
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

  async getAuthState(provider = "openai-codex"): Promise<PiAuthState> {
    if (this.authLogin) return this.authState;
    if (this.authState.status === "error") return this.authState;
    const authenticated = Boolean(await this.modelRuntime?.getAuth(provider));
    this.authState = authenticated ? { status: "authenticated" } : { status: "unauthenticated" };
    return this.authState;
  }

  async startLogin(provider = "openai-codex"): Promise<PiAuthState> {
    if ((await this.getAuthState(provider)).status === "authenticated" || this.authLogin) return this.authState;
    const modelRuntime = this.modelRuntime;
    if (!modelRuntime) throw new Error("Pi runtime is not connected");
    const controller = new AbortController();
    this.authController = controller;
    this.authState = { status: "starting", message: `Starting ${provider} login` };
    this.authLogin = modelRuntime.login(provider, "oauth", {
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

  async listModels(provider = "openai-codex"): Promise<readonly { id: string; name: string }[]> {
    const runtime = this.modelRuntime;
    if (!runtime) throw new Error("Runtime is not connected");
    if (provider === "nous") {
      const auth = await runtime.getAuth("nous");
      if (!auth?.auth.apiKey) throw new Error("Sign in to Nous first.");
      runtime.registerProvider("nous", { ...nousProvider(process.env["SLOPBOT_NOUS_CLIENT_ID"]), models: await nousModels(auth.auth.apiKey) });
    }
    return runtime.getModels(provider).map(({ id, name }) => ({ id, name }));
  }

  async listSkills(): Promise<readonly Skill[]> {
    const loader = this.skillLoader;
    if (!loader) throw new Error("Pi runtime is not connected");
    await loader.reload();
    return loader.getSkills().skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      content: readFileSync(skill.filePath, "utf8"),
      path: skill.filePath,
    }));
  }

  async createSkill(input: CreateSkillInput): Promise<Skill> {
    const parsed = CreateSkillInputSchema.parse(input);
    const skillsDirectory = join(getAgentDir(), "skills");
    const skillDirectory = join(skillsDirectory, parsed.name);
    if (existsSync(skillDirectory)) throw new Error("Skill already exists");
    mkdirSync(skillsDirectory, { recursive: true });
    mkdirSync(skillDirectory);
    try {
      writeFileSync(
        join(skillDirectory, "SKILL.md"),
        `---\nname: ${parsed.name}\ndescription: ${JSON.stringify(parsed.description)}\n---\n\n${parsed.content}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      const skill = (await this.listSkills()).find(
        (item) => item.name === parsed.name,
      );
      if (!skill) throw new Error("Pi did not load the new skill");
      return skill;
    } catch (error) {
      rmSync(skillDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  discardThread(threadId: ThreadId): void {
    const parsedId = ThreadIdSchema.parse(threadId);
    const managed = this.sessions.get(parsedId);
    if (!managed) return;
    managed.unsubscribe();
    managed.session.dispose();
    this.sessions.delete(parsedId);
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
    const parsedId = ThreadIdSchema.parse(threadId);
    const managed = this.sessions.get(parsedId);
    if (!managed) throw new Error(`Pi session not loaded: ${threadId}`);
    if (!await this.modelRuntime?.getAuth(managed.options.provider)) throw new Error("Sign in to the selected provider with /login.");
    if (managed.options.provider === "nous" && !this.modelRuntime?.getModel("nous", managed.options.model)) await this.listModels("nous");
    const selected = this.modelRuntime?.getModel(managed.options.provider, managed.options.model);
    if (!selected) throw new Error("Selected model is unavailable. Use /models and /model to choose one.");
    await managed.session.setModel(selected);
    const parsedInput = z.array(TurnInputSchema).min(1).parse(input);
    const text = parsedInput.filter((item): item is TextInput => item.type === "text").map((item) => item.text).join("\n\n");
    const skill = parsedInput.find((item): item is SkillInput => item.type === "skill");
    const images = parsedInput
      .filter((item): item is ImageInput => item.type === "image")
      .map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));
    const prompt = skill ? `/skill:${skill.name} ${text}` : text;
    const turnId = TurnIdSchema.parse(randomUUID());

    let preflightAccepted: boolean | undefined;
    let preflightError: unknown;
    let resolveAccepted: (accepted: boolean) => void = () => {};
    const accepted = new Promise<boolean>((resolve) => { resolveAccepted = resolve; });
    void managed.session.prompt(prompt, {
      ...(images.length ? { images } : {}),
      preflightResult: (value) => {
        preflightAccepted = value;
        resolveAccepted(value);
      },
    }).then(
      () => {
        if (preflightAccepted) {
          this.onTurnComplete?.(parsedId, "completed");
        }
      },
      (error: unknown) => {
        if (preflightAccepted !== true) {
          preflightError = error;
          resolveAccepted(false);
          return;
        }
        this.onText?.(parsedId, `Error: ${errorMessage(error)}`);
        this.onTurnComplete?.(parsedId, "failed");
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
    const customTools = [
      ...(options.dynamicTools ?? []).map((tool) => this.customTool(tool, threadId)),
    ];
    const { session } = await createAgentSession({
      cwd: options.cwd,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      thinkingLevel: "high",
      tools: [...(options.sandbox === "read-only" ? ["read", "grep", "find", "ls"] : ["read", "bash", "edit", "write", "grep", "find", "ls"]), ...customTools.map((tool) => tool.name)],
      customTools,
    });
    const unsubscribe = session.subscribe((event) => this.handleSessionEvent(threadId, event));
    this.discardThread(threadId);
    this.sessions.set(threadId, { session, unsubscribe, options });
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
        if (!this.onToolCall) throw new Error(`No handler registered for ${tool.name}`);
        const result = await this.onToolCall(threadId, tool.name, params);
        return typeof result === "string"
          ? { content: [{ type: "text", text: result }], details: {} }
          : { content: [{ type: "image", ...ImageAttachmentSchema.parse(result) }], details: {} };
      },
    };
  }

  private handleSessionEvent(threadId: ThreadId, event: AgentSessionEvent): void {
    if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
    this.onText?.(threadId, event.assistantMessageEvent.delta);
  }
}
