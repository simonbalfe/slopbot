import { z } from "zod";

export const ThreadIdSchema = z.string().min(1).brand<"ThreadId">();
export const SandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);

export type ThreadId = z.infer<typeof ThreadIdSchema>;
export type SandboxMode = z.infer<typeof SandboxModeSchema>;
