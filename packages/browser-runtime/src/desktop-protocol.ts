import { z } from "zod";

export const ComputerArgumentsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("screenshot") }),
  z.object({
    action: z.literal("click"),
    x: z.number().int().min(0).max(1279),
    y: z.number().int().min(0).max(1023),
    button: z.enum(["left", "middle", "right"]).default("left"),
    clickCount: z.number().int().min(1).max(2).default(1),
  }),
  z.object({ action: z.literal("type"), text: z.string().max(8_000) }),
  z.object({ action: z.literal("key"), key: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_+]+$/) }),
  z.object({
    action: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(100).default(3),
  }),
]);

export type ComputerArguments = Readonly<z.infer<typeof ComputerArgumentsSchema>>;

export const RelayToolNameSchema = z.enum(["read", "bash", "edit", "write", "grep", "find", "ls"]);
export const RelayCallSchema = z.object({
  id: z.string().min(1).max(200),
  name: RelayToolNameSchema,
  input: z.record(z.string(), z.unknown()),
});
export const RelayCatalogSchema = z.object({
  cwd: z.string().min(1),
  tools: z.array(z.object({
    name: RelayToolNameSchema,
    label: z.string().min(1),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  })).length(7).refine((tools) => new Set(tools.map((tool) => tool.name)).size === 7),
});
export const RelayResultSchema = z.object({
  content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string().max(2_000_000) }),
    z.object({ type: z.literal("image"), data: z.string().max(14_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]) }),
  ])),
  details: z.unknown().optional(),
});
