import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";

import { errorMessage, JsonObjectSchema, JsonRpcMessageSchema } from "./protocol.ts";
import type { JsonObject } from "./protocol.ts";

export const ThreadIdSchema = z.string().min(1).brand<"ThreadId">();
export const TurnIdSchema = z.string().min(1).brand<"TurnId">();
export const SandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
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
export const CodexAppServerOptionsSchema = z.object({
  cwd: z.string().min(1),
  clientName: z.string().min(1).optional(),
  clientTitle: z.string().min(1).optional(),
  clientVersion: z.string().min(1).optional(),
});
const RawSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  path: z.string().min(1),
  enabled: z.boolean(),
});
const SkillGroupSchema = z.object({ cwd: z.string(), skills: z.array(RawSkillSchema) });
const SkillListResultSchema = z.object({ data: z.array(SkillGroupSchema) });
const ThreadStartResultSchema = z.object({ thread: z.object({ id: ThreadIdSchema }) });
const ThreadReadResultSchema = z.object({
  thread: z.object({ id: ThreadIdSchema, turns: z.array(z.unknown()).default([]) }),
});
const TurnStartResultSchema = z.object({ turn: z.object({ id: TurnIdSchema }) });

export type ThreadId = z.infer<typeof ThreadIdSchema>;
export type TurnId = z.infer<typeof TurnIdSchema>;
export type SandboxMode = z.infer<typeof SandboxModeSchema>;
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export type Skill = Readonly<z.infer<typeof RawSkillSchema> & { cwd: string }>;

export type TextInput = Readonly<z.infer<typeof TextInputSchema>>;
export type SkillInput = Readonly<z.infer<typeof SkillInputSchema>>;
export type TurnInput = Readonly<z.infer<typeof TurnInputSchema>>;
export type DynamicTool = Readonly<z.infer<typeof DynamicToolSchema>>;
export type ThreadOptions = Readonly<z.infer<typeof ThreadOptionsSchema>>;

export type AppServerNotification = Readonly<{
  method: string;
  params: unknown;
}>;

export type AppServerRequest = AppServerNotification;
export type AppServerRequestHandler = (request: AppServerRequest) => Promise<JsonObject>;
export type AppServerNotificationHandler = (notification: AppServerNotification) => void;

export type CodexAppServerOptions = Readonly<z.infer<typeof CodexAppServerOptionsSchema>>;

type PendingRequest = Readonly<{
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>;

export class CodexAppServer {
  private readonly notifications = new Set<AppServerNotificationHandler>();
  private readonly pending = new Map<number, PendingRequest>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private requestHandler: AppServerRequestHandler | undefined;
  private nextId = 1;

  private readonly options: CodexAppServerOptions;

  constructor(options: CodexAppServerOptions) {
    this.options = CodexAppServerOptionsSchema.parse(options);
  }

  async connect(): Promise<void> {
    if (this.child) return;
    const child = spawn("codex", ["app-server"], { cwd: this.options.cwd, stdio: "pipe" });
    this.child = child;
    child.stderr.pipe(process.stderr);
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    child.on("error", (error) => this.stop(error));
    child.on("exit", (code) => this.stop(new Error(`Codex App Server exited (${code ?? "unknown"})`)));

    await this.request("initialize", {
      clientInfo: {
        name: this.options.clientName ?? "codex_app_server_client",
        title: this.options.clientTitle ?? "Codex App Server Client",
        version: this.options.clientVersion ?? "0.1.0",
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.send({ method: "initialized", params: {} });
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
  }

  onNotification(handler: AppServerNotificationHandler): () => void {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }

  handleRequests(handler: AppServerRequestHandler): void {
    this.requestHandler = handler;
  }

  async listSkills(cwds: readonly string[], forceReload = false): Promise<readonly Skill[]> {
    const validatedCwds = z.array(z.string().min(1)).min(1).parse(cwds);
    const { data } = SkillListResultSchema.parse(await this.request("skills/list", { cwds: validatedCwds, forceReload }));
    return data.flatMap((group) => group.skills.map((skill) => ({ cwd: group.cwd, ...skill })));
  }

  async startThread(options: ThreadOptions): Promise<ThreadId> {
    return ThreadStartResultSchema.parse(await this.request("thread/start", ThreadOptionsSchema.parse(options))).thread.id;
  }

  async resumeThread(threadId: ThreadId, options: ThreadOptions): Promise<ThreadId> {
    return ThreadStartResultSchema.parse(await this.request("thread/resume", {
      threadId: ThreadIdSchema.parse(threadId),
      ...ThreadOptionsSchema.parse(options),
    })).thread.id;
  }

  async threadContainsText(threadId: ThreadId, text: string): Promise<boolean> {
    const result = await this.request("thread/read", {
      threadId: ThreadIdSchema.parse(threadId),
      includeTurns: true,
    });
    return JSON.stringify(ThreadReadResultSchema.parse(result).thread.turns).includes(text);
  }

  async startTurn(threadId: ThreadId, input: readonly TurnInput[]): Promise<TurnId> {
    const result = await this.request("turn/start", {
      threadId: ThreadIdSchema.parse(threadId),
      input: z.array(TurnInputSchema).min(1).parse(input),
    });
    return TurnStartResultSchema.parse(result).turn.id;
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.nextId++;
    this.send({ method, id, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private send(message: JsonObject): void {
    if (!this.child) throw new Error("Codex App Server is not connected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = JsonRpcMessageSchema.safeParse(decoded);
    if (!parsed.success) return;
    const message = parsed.data;

    const { id, method } = message;
    if (method) {
      const incoming = { method, params: message.params } satisfies AppServerNotification;
      if (typeof id === "string" || typeof id === "number") void this.respond(id, incoming);
      else for (const handler of this.notifications) handler(incoming);
      return;
    }

    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  private async respond(id: string | number, request: AppServerRequest): Promise<void> {
    try {
      if (!this.requestHandler) throw new Error(`No handler registered for ${request.method}`);
      this.send({ id, result: await this.requestHandler(request) });
    } catch (error) {
      this.send({ id, error: { code: -32603, message: errorMessage(error) } });
    }
  }

  private stop(error: Error): void {
    this.child = undefined;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
