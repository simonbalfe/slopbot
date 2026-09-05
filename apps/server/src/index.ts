import { join, relative } from "node:path";

import { os } from "@orpc/server";
import type { RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { z } from "zod";

import {
  AgentController,
  BrowserInputSchema,
  UpdateAgentInputSchema,
  CreateSkillInputSchema,
  ImageAttachmentsSchema,
  PiRuntime,
  SandboxComputerOptionsSchema,
} from "slopbot";
import { errorMessage, textSchema } from "slopbot/protocol";

import { loadConfig } from "./config.ts";

const AgentIdSchema = z.object({ agentId: textSchema(100) });
const SendMessageSchema = AgentIdSchema.extend({
  text: z.string().trim().max(8_000).default(""),
  images: ImageAttachmentsSchema.default([]),
  skill: textSchema(100).nullish(),
}).refine(({ text, images }) => Boolean(text || images.length), {
  message: "A message or image is required",
});
const AgentBrowserInputSchema = AgentIdSchema.extend({
  input: BrowserInputSchema,
});

const config = loadConfig();
process.env["PI_CODING_AGENT_DIR"] = join(config.dataDirectory, "pi");
const computer = config.computer
  ? SandboxComputerOptionsSchema.parse({
      baseUrls: config.computer.baseUrls,
      publicUrls: config.computer.publicUrls,
      ...(config.computer.apiKey ? { apiKey: config.computer.apiKey } : {}),
    })
  : undefined;
const uiDirectory = join(import.meta.dir, "..", "ui-dist");
const uiIndex = join(uiDirectory, "index.html");
const runtime = new PiRuntime({ cwd: config.workspace });
const agents = new AgentController(runtime, {
  cwd: config.workspace,
  databasePath: join(config.dataDirectory, "slopbot.sqlite"),
  ...(computer ? { computer } : {}),
});
await agents.initialize();

export const appRouter = {
  auth: {
    state: os.handler(() => runtime.getAuthState(agents.botProfile().provider)),
    login: os.input(z.object({ provider: z.enum(["openai-codex", "nous"]).optional() }).optional()).handler(async ({ input }) => {
      const profile = agents.botProfile();
      const provider = input?.provider ?? profile.provider;
      if (provider !== profile.provider) await agents.updateBot({ ...profile, provider, model: provider === "openai-codex" ? "gpt-5.6-sol" : "select-a-model" });
      return runtime.startLogin(provider);
    }),
    models: os.handler(() => runtime.listModels(agents.botProfile().provider)),
  },
  agents: {
    list: os.handler(() => agents.listAgents()),
    profile: os.handler(() => agents.botProfile()),
    update: os.input(UpdateAgentInputSchema).handler(({ input }) => agents.updateBot(input)),
    send: os
      .input(SendMessageSchema)
      .handler(({ input }) =>
        agents.sendMessage(
          input.agentId,
          input.text,
          input.skill ?? undefined,
          input.images,
        ),
      ),
    clear: os
      .input(AgentIdSchema)
      .handler(({ input }) => agents.clearChat(input.agentId)),
    browserInput: os
      .input(AgentBrowserInputSchema)
      .handler(async ({ input }) => {
        await agents.browserInput(input.agentId, input.input);
        return { ok: true };
      }),
  },
  skills: {
    list: os.handler(() => agents.listSkills()),
    create: os
      .input(CreateSkillInputSchema)
      .handler(({ input }) => agents.createSkill(input)),
  },
};
export type AppClient = RouterClient<typeof appRouter>;

const rpc = new RPCHandler(appRouter);
const app = new Hono();

app.all("/rpc/*", async (context) => {
  const result = await rpc.handle(context.req.raw, { prefix: "/rpc" });
  return result.matched ? result.response : context.notFound();
});

app.get("/health", (context) => context.json({ ok: true }));

app.get(
  "/api/agents/:agentId/browser/screenshot",
  async (context) =>
    new Response(
      new Uint8Array(
        await agents.browserScreenshot(context.req.param("agentId")),
      ),
      { headers: { "cache-control": "no-store", "content-type": "image/png" } },
    ),
);

app.get("*", async (context) => {
  const pathname = new URL(context.req.url).pathname;
  const filePath = join(
    uiDirectory,
    pathname === "/" ? "index.html" : pathname,
  );
  const file = Bun.file(filePath);
  if (
    !relative(uiDirectory, filePath).startsWith("..") &&
    (await file.exists())
  )
    return new Response(file);
  return new Response(Bun.file(uiIndex), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});

app.onError((error, context) => {
  console.error(errorMessage(error));
  return context.json({ error: "Internal server error" }, 500);
});

const server = Bun.serve({
  fetch: app.fetch,
  hostname: config.hostname,
  port: config.port,
});

function shutdown(): void {
  server.stop();
  agents.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`SlopBot: http://${config.hostname}:${config.port}`);
