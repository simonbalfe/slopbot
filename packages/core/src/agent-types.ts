import { ModelSelectionSchema } from "@slopbot/contracts/providers";
export { ModelSelectionSchema } from "@slopbot/contracts/providers";
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
export const ImageAttachmentSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  data: z
    .string()
    .min(1)
    .max(14_000_000)
    .refine(
      (value) =>
        value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
      "Invalid base64 image",
    ),
});
export const ImageAttachmentsSchema = z
  .array(ImageAttachmentSchema)
  .max(4)
  .refine(
    (images) =>
      images.reduce((size, image) => size + image.data.length, 0) <=
      20_000_000,
    "Image attachments are too large",
  );
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
  ...ModelSelectionSchema.shape,
});
export const MessageEnvelopeSchema = z.object({
  id: MessageIdSchema,
  senderId: AgentIdSchema.nullable(),
  recipientId: AgentIdSchema,
  parentId: MessageIdSchema.nullable(),
  replyRequired: z.coerce.boolean(),
  text: textSchema(8_000),
  images: ImageAttachmentsSchema,
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
  images: ImageAttachmentsSchema,
  senderId: AgentIdSchema.nullable(),
  recipientId: AgentIdSchema.nullable(),
  createdAt: z.iso.datetime(),
  status: MessageStatusSchema.nullable(),
});
export const AgentViewSchema = AgentProfileSchema.pick({
  provider: true,
  model: true,
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
export type ImageAttachment = Readonly<z.infer<typeof ImageAttachmentSchema>>;
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
