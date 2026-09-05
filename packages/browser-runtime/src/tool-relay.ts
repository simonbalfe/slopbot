import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";
import { Value } from "typebox/value";

import { RelayCallSchema, RelayCatalogSchema, RelayResultSchema } from "./desktop-protocol.ts";

export function toolRelay(cwd: string): Hono {
  const tools = new Map([...createCodingTools(cwd), ...createReadOnlyTools(cwd)].map((tool) => [tool.name, tool]));
  const catalog = RelayCatalogSchema.parse({ cwd, tools: [...tools.values()].map(({ name, label, description, parameters }) => ({ name, label, description, parameters })) });
  return new Hono()
    .get("/", (context) => context.json(catalog))
    .post("/", async (context) => {
      const input = RelayCallSchema.parse(await context.req.json());
      const tool = tools.get(input.name);
      if (!tool || !Value.Check(tool.parameters, input.input)) {
        return context.json({ error: "Invalid tool arguments" }, 400);
      }
      const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(300_000)]);
      return context.json(RelayResultSchema.parse(await tool.execute(input.id, input.input, signal)));
    });
}
