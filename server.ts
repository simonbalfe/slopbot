import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { z } from "zod";

import {
  AgentController,
  AgentControllerError,
  CodexAppServer,
  createAgentId,
  SharedComputerOptionsSchema,
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
const hostname = z.string().min(1).parse(process.env["OPENBOT_HOST"] ?? "127.0.0.1");
const cwd = z.string().min(1).parse(process.env["OPENBOT_WORKSPACE"] ?? process.cwd());
const dataDirectory = z.string().min(1).parse(process.env["OPENBOT_DATA_DIR"] ?? join(cwd, ".openbot"));
const computer = process.env["OPENBOT_X11_DISPLAY"] ? SharedComputerOptionsSchema.parse({
  display: process.env["OPENBOT_X11_DISPLAY"],
  screens: process.env["OPENBOT_X11_SCREENS"] ?? 6,
  geometry: process.env["OPENBOT_X11_GEOMETRY"] ?? "1920x1080x24",
  browserProfileRoot: join(dataDirectory, "browsers"),
  viewerBaseUrl: process.env["OPENBOT_X11_VIEWER_BASE_URL"],
}) : undefined;
const uiDirectory = join(import.meta.dir, "ui-dist");
const uiIndex = join(uiDirectory, "index.html");
const client = new CodexAppServer({
  cwd,
  clientName: "openbot",
  clientTitle: "OpenBot",
});
const agents = new AgentController(client, {
  cwd,
  databasePath: join(dataDirectory, "openbot.sqlite"),
  ...(computer ? { computer } : {}),
  ...(process.env["OPENBOT_LOCAL_COMPUTER_URL"]
    ? { localComputerUrl: process.env["OPENBOT_LOCAL_COMPUTER_URL"] }
    : {}),
});
await agents.initialize();

async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  return schema.parse(await request.json());
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function uiResponse(pathname: string): Promise<Response> {
  const filePath = join(uiDirectory, pathname === "/" ? "index.html" : pathname);
  const file = Bun.file(filePath);
  if (!relative(uiDirectory, filePath).startsWith("..") && await file.exists()) return new Response(file);
  return new Response(Bun.file(uiIndex), { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/api/agents" && request.method === "GET") return Response.json(agents.listAgents());
  if (url.pathname === "/api/skills" && request.method === "GET") return Response.json(agents.listSkills());

  if (parts[0] === "api" && parts[1] === "agents" && parts[3] === "browser") {
    const agentId = parts[2];
    if (!agentId) return errorResponse("Agent not found", 404);
    if (parts[4] === "screenshot" && request.method === "GET") {
      return new Response(new Uint8Array(await agents.browserScreenshot(agentId)), {
        headers: { "cache-control": "no-store", "content-type": "image/png" },
      });
    }
    if (parts[4] === "input" && request.method === "POST") {
      await agents.browserInput(agentId, await request.json());
      return new Response(null, { status: 204 });
    }
  }

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
      return Response.json(agents.sendMessage(agentId, text, skill ?? undefined), { status: 202 });
    }

    if (parts[3] === "pass") {
      const { to } = await body(request, PassReplySchema);
      return Response.json(agents.passReply(agentId, to), { status: 202 });
    }

    if (parts[3] === "clear") return Response.json(await agents.clearChat(agentId));
  }

  if (url.pathname.startsWith("/api/")) return errorResponse("Not found", 404);
  return uiResponse(url.pathname);
}

const server = Bun.serve({
  hostname,
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
  agents.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`OpenBot: http://${hostname}:${port}`);
