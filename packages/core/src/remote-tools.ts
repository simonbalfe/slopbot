import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RelayCatalogSchema, RelayResultSchema } from "../../browser-runtime/src/desktop-protocol.ts";

export async function remoteTools(url: string, cwd: string, apiKey?: string): Promise<ToolDefinition[]> {
  const endpoint = `${url.replace(/\/$/, "")}/v1/tools`;
  const headers = { "content-type": "application/json", ...(apiKey ? { "X-AIO-API-Key": apiKey } : {}) };
  const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Computer tool discovery failed: HTTP ${response.status}`);
  const catalog = RelayCatalogSchema.parse(await response.json());
  if (catalog.cwd !== cwd) throw new Error(`Computer workspace is ${catalog.cwd}, expected ${cwd}`);
  return catalog.tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: `${tool.description}\nExecutes on the attached computer, never on the runtime host. Maximum execution time: 5 minutes.`,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
    execute: async (id, input, signal) => {
      const response = await fetch(endpoint, {
        method: "POST", headers, body: JSON.stringify({ id, name: tool.name, input }),
        signal: AbortSignal.any([AbortSignal.timeout(310_000), ...(signal ? [signal] : [])]),
      }).catch((error: unknown) => {
        throw new Error("Computer relay disconnected; execution outcome may be unknown. Inspect the computer before retrying.", { cause: error });
      });
      if (!response.ok) throw new Error(`Computer tool failed: HTTP ${response.status}: ${(await response.text()).slice(0, 2_000)}`);
      const result = RelayResultSchema.parse(await response.json());
      return { content: result.content, details: result.details ?? {} };
    },
  }));
}
