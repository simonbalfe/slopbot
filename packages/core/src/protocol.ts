import { z } from "zod";

export const JsonObjectSchema = z.record(z.string(), z.unknown());

export function textSchema(maximum: number): z.ZodString {
  return z.string().trim().min(1).max(maximum);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type JsonObject = z.infer<typeof JsonObjectSchema>;
