import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import {
  AgentIdSchema,
  AgentMessageSchema,
  AgentProfileSchema,
  ImageAttachmentsSchema,
  MessageEnvelopeSchema,
  MessageIdSchema,
} from "./agent-types.ts";
import type {
  AgentId,
  AgentMessage,
  AgentProfile,
  ImageAttachment,
  MessageEnvelope,
} from "./agent-types.ts";
import { ThreadIdSchema } from "./runtime-types.ts";
import type { ThreadId } from "./runtime-types.ts";

const StoredAgentRowSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  aliasesJson: z.string(),
  role: z.string(),
  sandbox: z.string(),
  instructions: z.string(),
  threadId: ThreadIdSchema.nullable(),
  threadConfig: z.string().nullable(),
});
const ColumnSchema = z.object({ name: z.string() });
const MessageEnvelopeRowSchema = MessageEnvelopeSchema.omit({
  images: true,
}).extend({ imagesJson: z.string() });
const AgentMessageRowSchema = AgentMessageSchema.omit({ images: true }).extend({
  imagesJson: z.string(),
});

export type StoredAgent = Readonly<{
  profile: AgentProfile;
  threadId: ThreadId | null;
  threadConfig: string | null;
}>;

type QueueMessageInput = Readonly<{
  senderId: AgentId | null;
  recipientId: AgentId;
  parentId: MessageEnvelope["parentId"];
  replyRequired: boolean;
  text: string;
  images: readonly ImageAttachment[];
  skillName: string | null;
}>;

export class AgentStore {
  private readonly database: Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath, { create: true });
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        role TEXT NOT NULL,
        sandbox TEXT NOT NULL,
        instructions TEXT NOT NULL,
        thread_id TEXT,
        thread_config TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retired_agents (
        id TEXT PRIMARY KEY,
        retired_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_envelopes (
        id TEXT PRIMARY KEY,
        sender_id TEXT REFERENCES agents(id),
        recipient_id TEXT NOT NULL REFERENCES agents(id),
        parent_id TEXT REFERENCES message_envelopes(id),
        reply_required INTEGER NOT NULL DEFAULT 0 CHECK(reply_required IN (0, 1)),
        text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 8000),
        images_json TEXT NOT NULL DEFAULT '[]',
        skill_name TEXT,
        status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'delivered', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        lease_expires_at TEXT,
        turn_id TEXT
      );
      CREATE INDEX IF NOT EXISTS message_inbox ON message_envelopes(recipient_id, status, created_at);
      CREATE TABLE IF NOT EXISTS transcript_events (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        message_id TEXT REFERENCES message_envelopes(id),
        role TEXT NOT NULL CHECK(role IN ('user', 'agent', 'assistant')),
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        text TEXT NOT NULL,
        sender_id TEXT REFERENCES agents(id),
        recipient_id TEXT REFERENCES agents(id),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_transcript ON transcript_events(agent_id, created_at);
      CREATE TABLE IF NOT EXISTS desktop_assignments (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        screen INTEGER NOT NULL UNIQUE CHECK(screen >= 0),
        created_at TEXT NOT NULL
      );
    `);
    const columns = ColumnSchema.array().parse(this.database.query("PRAGMA table_info(agents)").all());
    if (!columns.some(({ name }) => name === "thread_config")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN thread_config TEXT");
    }
    const messageColumns = ColumnSchema.array().parse(
      this.database.query("PRAGMA table_info(message_envelopes)").all(),
    );
    if (!messageColumns.some(({ name }) => name === "parent_id"))
      this.database.exec(
        "ALTER TABLE message_envelopes ADD COLUMN parent_id TEXT REFERENCES message_envelopes(id)",
      );
    if (!messageColumns.some(({ name }) => name === "reply_required"))
      this.database.exec(
        "ALTER TABLE message_envelopes ADD COLUMN reply_required INTEGER NOT NULL DEFAULT 0 CHECK(reply_required IN (0, 1))",
      );
    if (!messageColumns.some(({ name }) => name === "attempt_count"))
      this.database.exec(
        "ALTER TABLE message_envelopes ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0)",
      );
    if (!messageColumns.some(({ name }) => name === "lease_expires_at"))
      this.database.exec(
        "ALTER TABLE message_envelopes ADD COLUMN lease_expires_at TEXT",
      );
    if (!messageColumns.some(({ name }) => name === "images_json"))
      this.database.exec(
        "ALTER TABLE message_envelopes ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'",
      );
  }

  close(): void {
    this.database.close();
  }

  prepareSingleBot(profile: AgentProfile): void {
    if (!this.getAgent(profile.id)) this.createProfile(profile);
    const current = this.getAgent(profile.id);
    if (current?.profile.instructions === "Own intake, delegation, and synthesis. Send execution to WORKER and report only results the worker actually returns.")
      this.updateProfile(profile);
    this.database.query("DELETE FROM desktop_assignments WHERE agent_id != ? OR screen != 0").run(profile.id);
  }

  updateProfile(profile: AgentProfile): void {
    const parsed = AgentProfileSchema.parse(profile);
    this.database.query("UPDATE agents SET name = ?, role = ?, instructions = ?, sandbox = ?, aliases_json = ?, updated_at = ? WHERE id = ?")
      .run(parsed.name, parsed.role, parsed.instructions, parsed.sandbox, JSON.stringify(parsed.aliases), new Date().toISOString(), parsed.id);
  }

  upsertProfiles(profiles: readonly AgentProfile[]): void {
    for (const profile of profiles) {
      if (!this.isRetired(profile.id) && !this.getAgent(profile.id))
        this.insertProfile(profile);
    }
  }

  createProfile(profile: AgentProfile): StoredAgent {
    const validated = AgentProfileSchema.parse(profile);
    if (this.getAgent(validated.id)) throw new Error("Agent ID already exists");
    this.database.query("DELETE FROM retired_agents WHERE id = ?").run(validated.id);
    this.insertProfile(validated);
    const stored = this.getAgent(validated.id);
    if (!stored) throw new Error("Agent was not created");
    return stored;
  }

  hasPendingMessages(agentId: AgentId): boolean {
    return Boolean(
      this.database.query(`
        SELECT 1 FROM message_envelopes
        WHERE recipient_id = ? AND sender_id IS NULL
          AND status IN ('queued', 'processing')
        LIMIT 1
      `).get(agentId),
    );
  }

  deleteAgent(agentId: AgentId, retire = true): void {
    const remove = this.database.transaction(() => {
      if (retire)
        this.database.query(`
          INSERT INTO retired_agents (id, retired_at) VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET retired_at = excluded.retired_at
        `).run(agentId, new Date().toISOString());
      this.database.query(`
        DELETE FROM transcript_events
        WHERE agent_id = ? OR message_id IN (
          SELECT id FROM message_envelopes
          WHERE sender_id = ? OR recipient_id = ?
        )
      `).run(agentId, agentId, agentId);
      this.database.query(
        "DELETE FROM message_envelopes WHERE sender_id = ? OR recipient_id = ?",
      ).run(agentId, agentId);
      this.database.query("DELETE FROM desktop_assignments WHERE agent_id = ?").run(agentId);
      this.database.query("DELETE FROM agents WHERE id = ?").run(agentId);
    });
    remove();
  }

  setThread(agentId: AgentId, threadId: ThreadId, threadConfig: string): void {
    this.database.query("UPDATE agents SET thread_id = ?, thread_config = ?, updated_at = ? WHERE id = ?")
      .run(threadId, threadConfig, new Date().toISOString(), agentId);
  }

  getAgent(agentId: AgentId): StoredAgent | undefined {
    const row = this.database.query(`
      SELECT id, name, aliases_json AS aliasesJson, role, sandbox, instructions,
        thread_id AS threadId, thread_config AS threadConfig
      FROM agents WHERE id = ?
    `).get(agentId);
    return row ? this.parseAgent(row) : undefined;
  }

  listAgents(): readonly StoredAgent[] {
    return this.database.query(`
      SELECT id, name, aliases_json AS aliasesJson, role, sandbox, instructions,
        thread_id AS threadId, thread_config AS threadConfig
      FROM agents ORDER BY created_at, id
    `).all().map((row) => this.parseAgent(row));
  }

  assignDesktop(agentId: AgentId, screenCount: number): number | undefined {
    const existing = this.database.query("SELECT screen FROM desktop_assignments WHERE agent_id = ?").get(agentId);
    const existingScreen = z.object({ screen: z.number().int().nonnegative() }).safeParse(existing);
    if (existingScreen.success) return this.desktopScreen(existingScreen.data.screen, screenCount);

    const usedScreens = new Set(this.database.query("SELECT screen FROM desktop_assignments").all()
      .map((row) => z.object({ screen: z.number().int().nonnegative() }).parse(row).screen));
    const screen = Array.from({ length: screenCount }, (_, index) => index).find((index) => !usedScreens.has(index));
    if (screen === undefined) return undefined;
    this.database.query("INSERT INTO desktop_assignments (agent_id, screen, created_at) VALUES (?, ?, ?)")
      .run(agentId, screen, new Date().toISOString());
    return screen;
  }

  releaseDesktops(agentIds: readonly AgentId[]): void {
    const remove = this.database.query("DELETE FROM desktop_assignments WHERE agent_id = ?");
    for (const agentId of agentIds) remove.run(agentId);
  }

  queueMessage(input: QueueMessageInput): MessageEnvelope {
    const message = MessageEnvelopeSchema.parse({
      id: MessageIdSchema.parse(randomUUID()),
      ...input,
      status: "queued",
      createdAt: new Date().toISOString(),
      attemptCount: 0,
      deliveredAt: null,
      leaseExpiresAt: null,
      turnId: null,
    });
    const commit = this.database.transaction(() => {
      this.database.query(`
        INSERT INTO message_envelopes
          (id, sender_id, recipient_id, parent_id, reply_required, text,
           images_json, skill_name, status, attempt_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        message.senderId,
        message.recipientId,
        message.parentId,
        message.replyRequired ? 1 : 0,
        message.text,
        JSON.stringify(message.images),
        message.skillName,
        message.status,
        message.attemptCount,
        message.createdAt,
      );
      if (message.senderId) this.insertMessageEvent(message.senderId, message, "outbound");
      this.insertMessageEvent(message.recipientId, message, "inbound");
    });
    commit();
    return message;
  }

  listProcessingMessages(): readonly MessageEnvelope[] {
    return MessageEnvelopeSchema.array().parse(this.database.query(`
      SELECT
        id, sender_id AS senderId, recipient_id AS recipientId, text,
        images_json AS imagesJson,
        parent_id AS parentId, reply_required AS replyRequired,
        skill_name AS skillName, status, attempt_count AS attemptCount,
        created_at AS createdAt, delivered_at AS deliveredAt,
        lease_expires_at AS leaseExpiresAt, turn_id AS turnId
      FROM message_envelopes WHERE status = 'processing'
      ORDER BY created_at, id
    `).all().map((row) => this.parseMessageEnvelope(row)));
  }

  requeueMessage(messageId: string, retryLimit: number): boolean {
    const result = this.database
      .query(
        "UPDATE message_envelopes SET status = 'queued', lease_expires_at = NULL WHERE id = ? AND status = 'processing' AND attempt_count < ?",
      )
      .run(messageId, retryLimit);
    if (result.changes > 0) return true;
    this.markFailed(messageId);
    return false;
  }

  hasReply(messageId: string): boolean {
    return Boolean(
      this.database
        .query("SELECT 1 FROM message_envelopes WHERE parent_id = ? LIMIT 1")
        .get(messageId),
    );
  }

  claimNextMessage(agentId: AgentId): MessageEnvelope | undefined {
    const leaseExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const row = this.database.query(`
      UPDATE message_envelopes
      SET status = 'processing', attempt_count = attempt_count + 1,
        lease_expires_at = ?
      WHERE id = (
        SELECT id FROM message_envelopes
        WHERE recipient_id = ? AND sender_id IS NULL AND status = 'queued'
        ORDER BY created_at, id LIMIT 1
      )
      RETURNING
        id, sender_id AS senderId, recipient_id AS recipientId, text,
        images_json AS imagesJson,
        parent_id AS parentId, reply_required AS replyRequired,
        skill_name AS skillName, status, attempt_count AS attemptCount,
        created_at AS createdAt, delivered_at AS deliveredAt,
        lease_expires_at AS leaseExpiresAt, turn_id AS turnId
    `).get(leaseExpiresAt, agentId);
    return row ? this.parseMessageEnvelope(row) : undefined;
  }

  setTurn(messageId: string, turnId: string): void {
    this.database
      .query("UPDATE message_envelopes SET turn_id = ? WHERE id = ?")
      .run(turnId, messageId);
  }

  markCompleted(messageId: string): void {
    this.database.query(`
      UPDATE message_envelopes
      SET status = 'delivered', delivered_at = ?, lease_expires_at = NULL
      WHERE id = ?
    `).run(new Date().toISOString(), messageId);
  }

  markFailed(messageId: string): void {
    this.database
      .query(
        "UPDATE message_envelopes SET status = 'failed', lease_expires_at = NULL WHERE id = ?",
      )
      .run(messageId);
  }

  clearAgentChat(agentId: AgentId): void {
    const clear = this.database.transaction(() => {
      this.database.query("UPDATE message_envelopes SET status = 'failed' WHERE recipient_id = ? AND status = 'queued'")
        .run(agentId);
      this.database.query("DELETE FROM transcript_events WHERE agent_id = ?").run(agentId);
    });
    clear();
  }

  listMessages(agentId: AgentId): readonly AgentMessage[] {
    return AgentMessageSchema.array().parse(this.database.query(`
      SELECT
        e.id, e.agent_id AS agentId, e.message_id AS messageId, e.role, e.direction,
        e.text, e.sender_id AS senderId, e.recipient_id AS recipientId,
        e.created_at AS createdAt, m.status,
        COALESCE(m.images_json, '[]') AS imagesJson
      FROM transcript_events e
      LEFT JOIN message_envelopes m ON m.id = e.message_id
      WHERE e.agent_id = ?
      ORDER BY e.created_at, e.rowid
    `).all(agentId).map((row) => this.parseAgentMessage(row)));
  }

  lastMessage(agentId: AgentId): AgentMessage | undefined {
    const row = this.database.query(`
      SELECT
        e.id, e.agent_id AS agentId, e.message_id AS messageId, e.role, e.direction,
        e.text, e.sender_id AS senderId, e.recipient_id AS recipientId,
        e.created_at AS createdAt, m.status,
        COALESCE(m.images_json, '[]') AS imagesJson
      FROM transcript_events e
      LEFT JOIN message_envelopes m ON m.id = e.message_id
      WHERE e.agent_id = ?
      ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1
    `).get(agentId);
    return row ? this.parseAgentMessage(row) : undefined;
  }

  addAssistantMessage(agentId: AgentId, text: string): AgentMessage {
    const message = AgentMessageSchema.parse({
      id: randomUUID(),
      agentId,
      messageId: null,
      role: "assistant",
      direction: "outbound",
      text,
      images: [],
      senderId: agentId,
      recipientId: null,
      createdAt: new Date().toISOString(),
      status: null,
    });
    this.insertEvent(message);
    return message;
  }

  updateMessageText(messageId: string, text: string): void {
    this.database.query("UPDATE transcript_events SET text = ? WHERE id = ?").run(text, messageId);
  }

  private insertProfile(profile: AgentProfile): void {
    const validated = AgentProfileSchema.parse(profile);
    const now = new Date().toISOString();
    this.database.query(`
      INSERT INTO agents
        (id, name, aliases_json, role, sandbox, instructions, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      validated.id,
      validated.name,
      JSON.stringify(validated.aliases),
      validated.role,
      validated.sandbox,
      validated.instructions,
      now,
      now,
    );
  }

  private isRetired(agentId: AgentId): boolean {
    return Boolean(
      this.database.query("SELECT 1 FROM retired_agents WHERE id = ?").get(agentId),
    );
  }

  private desktopScreen(screen: number, screenCount: number): number {
    if (screen >= screenCount) throw new Error(`X11 screen ${screen} exceeds configured capacity ${screenCount}`);
    return screen;
  }

  private parseAgent(value: unknown): StoredAgent {
    const row = StoredAgentRowSchema.parse(value);
    return {
      profile: AgentProfileSchema.parse({ ...row, aliases: z.array(z.string()).parse(JSON.parse(row.aliasesJson)) }),
      threadId: row.threadId,
      threadConfig: row.threadConfig,
    };
  }

  private insertMessageEvent(agentId: AgentId, message: MessageEnvelope, direction: "inbound" | "outbound"): void {
    this.insertEvent(AgentMessageSchema.parse({
      id: randomUUID(),
      agentId,
      messageId: message.id,
      role: message.senderId ? "agent" : "user",
      direction,
      text: message.text,
      images: message.images,
      senderId: message.senderId,
      recipientId: message.recipientId,
      createdAt: message.createdAt,
      status: message.status,
    }));
  }

  private insertEvent(message: AgentMessage): void {
    this.database.query(`
      INSERT INTO transcript_events
        (id, agent_id, message_id, role, direction, text, sender_id, recipient_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.agentId,
      message.messageId,
      message.role,
      message.direction,
      message.text,
      message.senderId,
      message.recipientId,
      message.createdAt,
    );
  }

  private parseMessageEnvelope(value: unknown): MessageEnvelope {
    const row = MessageEnvelopeRowSchema.parse(value);
    const { imagesJson, ...message } = row;
    return MessageEnvelopeSchema.parse({
      ...message,
      images: ImageAttachmentsSchema.parse(JSON.parse(imagesJson)),
    });
  }

  private parseAgentMessage(value: unknown): AgentMessage {
    const row = AgentMessageRowSchema.parse(value);
    const { imagesJson, ...message } = row;
    return AgentMessageSchema.parse({
      ...message,
      images: ImageAttachmentsSchema.parse(JSON.parse(imagesJson)),
    });
  }
}
