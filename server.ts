import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  AgentController,
  AgentControllerError,
  CodexAppServer,
  createAgentId,
} from "./src/index.ts";
import { errorMessage, textSchema } from "./src/protocol.ts";

const CreateAgentSchema = z.object({
  name: textSchema(50),
  role: textSchema(200),
});
const SendMessageSchema = z.object({
  text: textSchema(8_000),
  skill: textSchema(100).nullish(),
});
const PassReplySchema = z.object({ to: textSchema(100) });

const port = z.coerce.number().int().min(1).max(65_535).parse(process.env["PORT"] ?? 4317);
const cwd = process.cwd();
const html = await Bun.file(new URL("./index.html", import.meta.url)).text();
const client = new CodexAppServer({
  cwd,
  clientName: "openbot",
  clientTitle: "OpenBot",
});
const agents = new AgentController(client, cwd);
await agents.initialize();

async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  return schema.parse(await request.json());
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/api/agents" && request.method === "GET") return Response.json(agents.listAgents());
  if (url.pathname === "/api/skills" && request.method === "GET") return Response.json(agents.listSkills());

  if (url.pathname === "/api/agents" && request.method === "POST") {
    const { name, role } = await body(request, CreateAgentSchema);
    const agent = await agents.createAgent({
      id: createAgentId(randomUUID()),
      name,
      aliases: [name],
      role,
      sandbox: "read-only",
      instructions: "Own this specialty and return concise, evidence-backed results to the requesting teammate.",
    });
    return Response.json(agent, { status: 201 });
  }

  if (parts[0] === "api" && parts[1] === "agents" && parts.length === 4 && request.method === "POST") {
    const agentId = parts[2];
    if (!agentId) return errorResponse("Agent not found", 404);

    if (parts[3] === "messages") {
      const { skill, text } = await body(request, SendMessageSchema);
      agents.sendMessage(agentId, text, skill ?? undefined);
      return new Response(null, { status: 202 });
    }

    if (parts[3] === "pass") {
      const { to } = await body(request, PassReplySchema);
      agents.passReply(agentId, to);
      return new Response(null, { status: 202 });
    }
  }

  if (url.pathname.startsWith("/api/")) return errorResponse("Not found", 404);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request): Promise<Response> {
    try {
      return await route(request);
    } catch (error) {
      if (error instanceof z.ZodError) return errorResponse(z.prettifyError(error), 400);
      if (error instanceof AgentControllerError) {
        return errorResponse(error.message, error.code === "agent-not-found" ? 404 : 400);
      }
      console.error(errorMessage(error));
      return errorResponse("Internal server error", 500);
    }
  },
});

function shutdown(): void {
  server.stop();
  client.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`OpenBot: http://127.0.0.1:${port}`);
