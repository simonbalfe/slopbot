import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { dialog } from "electron";
import { z } from "zod";

import {
  LocalComputerRequestSchema,
  LocalComputerResultSchema,
} from "slopbot/local-computer";
import type { LocalComputerRequest, LocalComputerResult } from "slopbot/local-computer";

const port = z.coerce.number().int().min(1).max(65_535).parse(process.env["SLOPBOT_LOCAL_PORT"] ?? 4318);
const maxFileBytes = 64 * 1_024;

function tailscaleAddress(): string | undefined {
  return Object.values(networkInterfaces()).flatMap((entries) => entries ?? []).find((entry) => {
    if (entry.family !== "IPv4") return false;
    const octets = entry.address.split(".").map(Number);
    const second = octets[1];
    return octets[0] === 100 && second !== undefined && second >= 64 && second <= 127;
  })?.address;
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16_384) throw new Error("Request is too large");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function approved(request: LocalComputerRequest): Promise<boolean> {
  const action = request.operation.tool === "read_file" ? "read a file" : "list a directory";
  const result = await dialog.showMessageBox({
    type: "question",
    title: "SlopBot local computer access",
    message: `${request.agentName} wants to ${action}`,
    detail: request.operation.path,
    buttons: ["Deny", "Allow once"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
}

async function localPath(requestedPath: string): Promise<string> {
  const root = await realpath(homedir());
  const expanded = requestedPath === "~"
    ? root
    : requestedPath.startsWith("~/")
      ? resolve(root, requestedPath.slice(2))
      : isAbsolute(requestedPath)
        ? requestedPath
        : resolve(root, requestedPath);
  const target = await realpath(expanded);
  const child = relative(root, target);
  if (child.startsWith("..") || isAbsolute(child)) throw new Error("Path must be inside the user's home directory");
  return target;
}

async function execute(request: LocalComputerRequest): Promise<LocalComputerResult> {
  if (!await approved(request)) return { success: false, error: "Denied by user" };
  try {
    const target = await localPath(request.operation.path);
    if (request.operation.tool === "list_directory") {
      const entries = (await readdir(target, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 200)
        .map((entry) => `${entry.isDirectory() ? "directory" : "file"}\t${entry.name}`);
      return { success: true, output: entries.join("\n") || "Directory is empty" };
    }
    const metadata = await stat(target);
    if (!metadata.isFile()) return { success: false, error: "Path is not a file" };
    if (metadata.size > maxFileBytes) return { success: false, error: "File exceeds the 64 KiB read limit" };
    const contents = await readFile(target);
    if (contents.includes(0)) return { success: false, error: "Binary files are not supported" };
    return { success: true, output: contents.toString("utf8") };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Local read failed" };
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST" || request.url !== "/execute") {
    send(response, 404, { error: "Not found" });
    return;
  }
  try {
    const input = LocalComputerRequestSchema.parse(await requestBody(request));
    send(response, 200, LocalComputerResultSchema.parse(await execute(input)));
  } catch (error) {
    send(response, 400, { success: false, error: error instanceof Error ? error.message : "Invalid request" });
  }
}

export function startLocalComputer(): Server | undefined {
  const hostname = process.env["SLOPBOT_LOCAL_HOST"] ?? tailscaleAddress();
  if (!hostname) {
    console.warn("SlopBot local computer access is disabled because Tailscale is unavailable");
    return undefined;
  }
  const server = createServer((request, response) => void handle(request, response));
  server.listen(port, hostname, () => console.log(`SlopBot local computer: http://${hostname}:${port}`));
  return server;
}
