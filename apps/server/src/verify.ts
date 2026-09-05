import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { z } from "zod";
import { AgentController, PiRuntime, UpdateAgentInputSchema, defaultAgentProfiles } from "slopbot";
import { AgentStore } from "../../../packages/core/src/agent-store.ts";
import { createAgentId } from "../../../packages/core/src/agent-types.ts";
import { ThreadIdSchema, TurnIdSchema } from "../../../packages/core/src/pi-runtime.ts";
import type { Skill, ThreadId, ThreadOptions, TurnId } from "../../../packages/core/src/pi-runtime.ts";
import { remoteTools } from "../../../packages/core/src/remote-tools.ts";
import { toolRelay } from "../../../packages/browser-runtime/src/tool-relay.ts";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { responseMarkdown } from "./terminal.ts";

const markdown = responseMarkdown("## Heading\n\n**bold** and `code`\n\n| Flag | Meaning |\n| --- | --- |\n| --test | Check |\n\n```sh\necho hello\n```\n");
for (const width of [36, 80]) {
  const lines = markdown.render(width);
  const rendered = stripVTControlCharacters(lines.join("\n"));
  assert.ok(rendered.includes("bold") && !rendered.includes("**bold**"));
  assert.ok(rendered.includes("echo hello") && !rendered.includes("```"));
  assert.ok(rendered.includes("Flag") && !rendered.includes("| --- |"));
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
}
markdown.setText("**streaming");
markdown.render(36);
markdown.setText("**streaming complete**");
assert.ok(!stripVTControlCharacters(markdown.render(36).join("\n")).includes("**"));

class CheckRuntime extends PiRuntime {
  optionsSeen: ThreadOptions | undefined;
  override async connect(): Promise<void> {}
  override close(): void {}
  override async listSkills(): Promise<readonly Skill[]> { return []; }
  override async startThread(options: ThreadOptions): Promise<ThreadId> {
    this.optionsSeen = options;
    return ThreadIdSchema.parse(crypto.randomUUID());
  }
  override async resumeThread(id: ThreadId, options: ThreadOptions): Promise<ThreadId> {
    this.optionsSeen = options;
    return id;
  }
  override async startTurn(id: ThreadId): Promise<TurnId> {
    await this.onToolCall?.(id, "browser", { action: "navigate", url: "https://example.com" });
    await assert.rejects(() => this.onToolCall!(id, "computer", { action: "click", x: -1, y: 0 }));
    const screenshot = await this.onToolCall?.(id, "computer", { action: "screenshot" });
    assert.equal(typeof screenshot, "object");
    assert.ok(screenshot && typeof screenshot !== "string" && screenshot.mimeType === "image/png");
    await this.onToolCall?.(id, "computer", { action: "key", key: "alt+F2" });
    setTimeout(() => {
      this.onText?.(id, "Verified browser response");
      this.onTurnComplete?.(id, "completed");
    }, 20);
    return TurnIdSchema.parse(crypto.randomUUID());
  }
}

const directory = mkdtempSync(join(tmpdir(), "slopbot-check-"));
const relay = new Hono().route("/v1/tools", toolRelay(directory));
relay.onError((error, context) => context.json({ error: error.message }, error instanceof z.ZodError ? 400 : 500));
const relayServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: relay.fetch });
const databasePath = join(directory, "bot.sqlite");
const requests: string[] = [];
const browser = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
  requests.push(new URL(request.url).pathname);
  if (new URL(request.url).pathname === "/v1/desktop") {
    const input = z.object({ action: z.string() }).parse(await request.json());
    if (input.action === "screenshot") return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=", "base64"), { headers: { "content-type": "image/png" } });
  }
  return Response.json({ success: true, data: true });
} });
const options = { cwd: directory, databasePath, computer: { baseUrls: [browser.url.href], publicUrls: [browser.url.href] } };
const seed = new AgentStore(databasePath);
seed.createProfile({ ...defaultAgentProfiles[0], name: "LEAD", instructions: "Own intake, delegation, and synthesis. Send execution to WORKER and report only results the worker actually returns." });
seed.createProfile({ ...defaultAgentProfiles[0], id: createAgentId("worker") });
seed.close();
const runtime = new CheckRuntime({ cwd: directory });
const controller = new AgentController(runtime, options);
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const tools = await remoteTools(relayServer.url.href, directory);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  const execute = (name: string, input: unknown): Promise<Response> => fetch(new URL("/v1/tools", relayServer.url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), name, input }),
  });
  assert.equal((await execute("write", { path: "relay.txt", content: "before" })).status, 200);
  assert.equal((await execute("edit", { path: "relay.txt", edits: [{ oldText: "before", newText: "after" }] })).status, 200);
  assert.match(await (await execute("read", { path: "relay.txt" })).text(), /after/);
  assert.equal((await execute("bash", { command: 42 })).status, 400);
  assert.equal((await execute("unknown", {})).status, 400);
  await assert.rejects(remoteTools(relayServer.url.href, "/wrong-workspace"));
  relayServer.stop(true);
  await assert.rejects(remoteTools(relayServer.url.href, directory));
  await controller.initialize();
  assert.equal(controller.listAgents().length, 1);
  assert.equal(controller.botProfile().name, "SlopBot");
  assert.deepEqual(runtime.optionsSeen?.dynamicTools?.map((tool) => tool.name), ["browser", "computer"]);
  assert.ok(runtime.optionsSeen?.developerInstructions?.includes(`Your host workspace is ${directory}`));
  assert.ok(runtime.optionsSeen?.developerInstructions?.includes("tools operate locally on this host"));
  const thread = controller.listAgents()[0]?.threadId;
  await assert.rejects(controller.updateBot({ name: "", role: "Role", instructions: "Instructions" }));
  const handler = new RPCHandler({
    auth: { state: os.handler(() => ({ status: "authenticated" })) },
    agents: {
      profile: os.handler(() => controller.botProfile()),
      update: os.input(UpdateAgentInputSchema).handler(({ input }) => controller.updateBot(input)),
      list: os.handler(() => controller.listAgents()),
      send: os.input(z.object({ agentId: z.string(), text: z.string() })).handler(({ input }) => controller.sendMessage(input.agentId, input.text)),
    },
  });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
    const result = await handler.handle(request, { prefix: "/rpc" });
    return result.matched ? result.response : new Response(null, { status: 404 });
  } });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "chat.ts"), server.url.href], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write("/name Nova\n/instructions Be concise.\n/config\nhello\n/clear\n/quit\n");
  child.stdin.end();
  const timeout = setTimeout(() => child.kill(), 10_000);
  const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timeout);
  assert.equal(exit, 0, errors);
  assert.match(output, /Saved in SQLite/);
  assert.match(output, /Verified browser response/);
  assert.ok(output.includes("\u001b[1;1H\u001b[0J"));
  assert.equal(controller.botProfile().name, "Nova");
  assert.equal(controller.listAgents()[0]?.threadId, thread);
  assert.match(runtime.optionsSeen?.developerInstructions ?? "", /Be concise\./);
  assert.ok(requests.includes("/v1/browser/page/navigate"));
  assert.ok(requests.includes("/v1/desktop"));
  controller.close();
  const restored = new AgentController(new CheckRuntime({ cwd: directory }), options);
  try {
    await restored.initialize();
    assert.equal(restored.botProfile().name, "Nova");
    assert.equal(restored.listAgents()[0]?.threadId, thread);
    assert.ok(restored.listAgents()[0]?.messages.some((message) => message.text === "Verified browser response"));
  } finally { restored.close(); }
  const stored = new AgentStore(databasePath);
  assert.ok(stored.getAgent(createAgentId("worker")));
  stored.close();
  console.log("Verified single bot, SQLite configuration, session continuity, browser dispatch, and terminal chat.");
} finally {
  controller.close();
  server?.stop(true);
  browser.stop(true);
  relayServer.stop(true);
  rmSync(directory, { recursive: true, force: true });
}
