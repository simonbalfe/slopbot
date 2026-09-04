import { z } from "zod";

export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const JsonRpcMessageSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

export function textSchema(maximum: number): z.ZodString {
  return z.string().trim().min(1).max(maximum);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type JsonObject = z.infer<typeof JsonObjectSchema>;
