import { z } from "zod";

import { textSchema } from "./protocol.ts";
import { SandboxModeSchema, ThreadIdSchema } from "./runtime-types.ts";

export const AgentIdSchema = textSchema(100).brand<"AgentId">();
export const MessageIdSchema = z.uuid().brand<"MessageId">();
export const AgentStatusSchema = z.enum(["idle", "running", "error"]);
export const MessageStatusSchema = z.enum([
  "queued",
  "processing",
  "delivered",
  "failed",
]);
export const DesktopAssignmentSchema = z.object({
  computerId: z.literal("slopbot-browser"),
  screen: z.number().int().nonnegative(),
  viewerUrl: z.url().nullable(),
});
export const AgentProfileSchema = z.object({
  id: AgentIdSchema,
  name: textSchema(50),
  aliases: z.array(textSchema(50)).min(1),
  role: textSchema(200),
  sandbox: SandboxModeSchema,
  instructions: textSchema(2_000),
});
export const MessageEnvelopeSchema = z.object({
  id: MessageIdSchema,
  senderId: AgentIdSchema.nullable(),
  recipientId: AgentIdSchema,
  parentId: MessageIdSchema.nullable(),
  replyRequired: z.coerce.boolean(),
  text: textSchema(8_000),
  skillName: textSchema(100).nullable(),
  status: MessageStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  turnId: z.string().nullable(),
});
export const AgentMessageSchema = z.object({
  id: z.uuid(),
  agentId: AgentIdSchema,
  messageId: MessageIdSchema.nullable(),
  role: z.enum(["user", "agent", "assistant"]),
  direction: z.enum(["inbound", "outbound"]),
  text: z.string(),
  senderId: AgentIdSchema.nullable(),
  recipientId: AgentIdSchema.nullable(),
  createdAt: z.iso.datetime(),
  status: MessageStatusSchema.nullable(),
});
export const AgentViewSchema = AgentProfileSchema.pick({
  id: true,
  name: true,
  role: true,
  sandbox: true,
}).extend({
  threadId: ThreadIdSchema,
  desktop: DesktopAssignmentSchema.nullable(),
  messages: z.array(AgentMessageSchema),
  status: AgentStatusSchema,
});

export type AgentId = z.infer<typeof AgentIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type MessageStatus = z.infer<typeof MessageStatusSchema>;
export type DesktopAssignment = Readonly<
  z.infer<typeof DesktopAssignmentSchema>
>;
export type AgentProfile = Readonly<z.infer<typeof AgentProfileSchema>>;
export type MessageEnvelope = Readonly<z.infer<typeof MessageEnvelopeSchema>>;
export type AgentMessage = Readonly<z.infer<typeof AgentMessageSchema>>;
export type AgentView = Readonly<z.infer<typeof AgentViewSchema>>;

export function createAgentId(value: string): AgentId {
  return AgentIdSchema.parse(value);
}
