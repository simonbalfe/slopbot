import { z } from "zod";

import { AgentIdSchema } from "./agent-types.ts";
import { textSchema } from "./protocol.ts";

const LocalPathSchema = textSchema(4_096);

export const LocalComputerOperationSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("read_file"), path: LocalPathSchema }),
  z.object({ tool: z.literal("list_directory"), path: LocalPathSchema }),
]);
export const LocalComputerRequestSchema = z.object({
  agentId: AgentIdSchema,
  agentName: textSchema(50),
  operation: LocalComputerOperationSchema,
});
export const LocalComputerResultSchema = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), output: z.string() }),
  z.object({ success: z.literal(false), error: z.string() }),
]);
export const LocalComputerClientOptionsSchema = z.object({
  url: z.url(),
});

export type LocalComputerOperation = Readonly<z.infer<typeof LocalComputerOperationSchema>>;
export type LocalComputerRequest = Readonly<z.infer<typeof LocalComputerRequestSchema>>;
export type LocalComputerResult = Readonly<z.infer<typeof LocalComputerResultSchema>>;
export type LocalComputerClientOptions = Readonly<z.infer<typeof LocalComputerClientOptionsSchema>>;

export class LocalComputerClient {
  private readonly url: string;

  constructor(options: LocalComputerClientOptions) {
    this.url = LocalComputerClientOptionsSchema.parse(options).url.replace(/\/$/, "");
  }

  async execute(request: LocalComputerRequest): Promise<LocalComputerResult> {
    const response = await fetch(`${this.url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(LocalComputerRequestSchema.parse(request)),
      signal: AbortSignal.timeout(600_000),
    });
    return LocalComputerResultSchema.parse(await response.json());
  }
}
