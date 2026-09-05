import { clearScreenDown, createInterface, cursorTo } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { z } from "zod";

import { errorMessage } from "slopbot/protocol";
import type { AppClient } from "./index.ts";
import { SlopBotTerminal } from "./terminal.ts";

let terminal: SlopBotTerminal | undefined;

const help = "/clear · /config · /name TEXT · /role TEXT · /instructions TEXT · /computer · /login [nous|openai-codex] · /models · /model ID · /quit";
const address = z.url().parse(process.argv[2] ?? `http://127.0.0.1:${process.env["PORT"] ?? "4317"}`);
const api: AppClient = createORPCClient(new RPCLink({
  url: new URL("/rpc", address).href,
  fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }),
}));

function output(value: string): void {
  if (terminal) { terminal.write(value); return; }
  process.stdout.write(stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""));
}

async function login(provider?: "nous" | "openai-codex"): Promise<void> {
  let state = await api.auth.state();
  if (state.status === "authenticated" && !provider) return;
  state = await api.auth.login(provider ? { provider } : undefined);
  let displayed = "";
  while (state.status !== "authenticated") {
    if (state.status === "error") throw new Error(state.message);
    if (state.status === "unauthenticated") throw new Error("Login did not complete. Use /login to retry.");
    const message = state.status === "pending"
      ? `Open ${state.verificationUri}\nCode: ${state.userCode}\n`
      : `${state.message}\n`;
    if (message !== displayed) { output(message); displayed = message; }
    await setTimeout(1_000);
    state = await api.auth.state();
  }
  output("Signed in.\n");
  if (provider === "nous") output("Use /models to list available models, then /model MODEL_ID to select one.\n");
}

async function chat(text: string): Promise<void> {
  const [bot] = await api.agents.list();
  if (!bot) throw new Error("No bot is available");
  const lengths = new Map(bot.messages.map((message) => [message.id, message.text.length]));
  const queued = await api.agents.send({ agentId: bot.id, text });
  for (;;) {
    const [current] = await api.agents.list();
    if (!current) throw new Error("Bot is unavailable");
    for (const message of current.messages) {
      if (message.role !== "assistant") continue;
      const length = lengths.get(message.id) ?? 0;
      if (!lengths.has(message.id)) output("\n");
      output(message.text.slice(length));
      lengths.set(message.id, message.text.length);
    }
    const delivery = current.messages.find((message) => message.messageId === queued.id && message.direction === "inbound");
    if (delivery?.status === "delivered" || delivery?.status === "failed") {
      output(delivery.status === "failed" ? "\n[Turn failed]\n" : "\n");
      return;
    }
    await setTimeout(300);
  }
}

async function main(): Promise<void> {
  if (process.stdin.isTTY && process.stdout.isTTY) terminal = new SlopBotTerminal();
  else output(`SlopBot\n`);
  const profile = await api.agents.profile();
  if (!terminal) output(`Connected to ${profile.name}.\n`);
  const input = terminal ? undefined : createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  try {
    for await (const line of terminal?.lines() ?? input!) {
      const text = line.trim();
      if (text === "/quit" || text === "/exit") break;
      try {
        if (text === "/clear") {
          if (terminal) terminal.clear();
          else { cursorTo(process.stdout, 0, 0); clearScreenDown(process.stdout); }
        } else if (text === "/help") output(`${help}\n`);
        else if (text === "/login" || text.startsWith("/login ")) {
          const provider = text.split(/\s+/)[1];
          if (provider !== undefined && provider !== "nous" && provider !== "openai-codex") throw new Error("Use /login nous or /login openai-codex");
          await login(provider);
        } else if (text === "/models") output((await api.auth.models()).map((model) => model.id).join("\n") + "\n");
        else if (text.startsWith("/model ")) {
          const model = text.slice(7).trim();
          if (!(await api.auth.models()).some((item) => item.id === model)) throw new Error("Choose an available model from /models");
          const profile = await api.agents.profile();
          await api.agents.update({ ...profile, model });
          output("Model selected.\n");
        }
        else if (text === "/config") {
          const { name, role, instructions, provider, model } = await api.agents.profile();
          output(JSON.stringify({ name, role, instructions, provider, model }, null, 2) + "\n");
        } else if (text === "/browser" || text === "/computer") {
          const [bot] = await api.agents.list();
          output(`${bot?.desktop?.viewerUrl ?? "Computer is not configured"}\n`);
        } else if (/^\/(name|role|instructions)(?:\s|$)/.test(text)) {
          const field = text.slice(1).split(/\s/, 1)[0];
          if (field !== "name" && field !== "role" && field !== "instructions") throw new Error("Unknown setting");
          const profile = await api.agents.profile();
          await api.agents.update({ ...profile, [field]: text.slice(field.length + 1).trim() });
          output("Saved in SQLite.\n");
        } else if (text.startsWith("/")) output(`Unknown command. ${help}\n`);
        else if (text) await chat(text);
      } catch (error) { output(`Error: ${errorMessage(error)}\n`); }
    }
  } finally { input?.close(); terminal?.close(); }
}

await main().catch((error: unknown) => {
  output(`Error: ${errorMessage(error)}\nStart the stack with bun run chat.\n`);
  terminal?.close();
  process.exitCode = 1;
});
