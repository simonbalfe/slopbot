import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import {
  AgentIdSchema,
  AgentMessageSchema,
  AgentProfileSchema,
  MessageEnvelopeSchema,
  MessageIdSchema,
} from "./agent-types.ts";
import type { AgentId, AgentMessage, AgentProfile, MessageEnvelope } from "./agent-types.ts";
import { ThreadIdSchema } from "./codex-app-server.ts";
import type { ThreadId } from "./codex-app-server.ts";

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

export type StoredAgent = Readonly<{
  profile: AgentProfile;
  threadId: ThreadId | null;
  threadConfig: string | null;
}>;

type QueueMessageInput = Readonly<{
  senderId: AgentId | null;
  recipientId: AgentId;
  text: string;
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
      CREATE TABLE IF NOT EXISTS message_envelopes (
        id TEXT PRIMARY KEY,
        sender_id TEXT REFERENCES agents(id),
        recipient_id TEXT NOT NULL REFERENCES agents(id),
        text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 8000),
        skill_name TEXT,
        status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'delivered', 'failed')),
        created_at TEXT NOT NULL,
        delivered_at TEXT,
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
  }

  close(): void {
    this.database.close();
  }

  upsertProfiles(profiles: readonly AgentProfile[]): void {
    for (const profile of profiles) this.saveProfile(profile, null);
  }

  saveAgent(profile: AgentProfile, threadId: ThreadId, threadConfig: string): void {
    this.saveProfile(profile, threadId, threadConfig);
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

  assignDesktop(agentId: AgentId, screenCount: number): number {
    const existing = this.database.query("SELECT screen FROM desktop_assignments WHERE agent_id = ?").get(agentId);
    const existingScreen = z.object({ screen: z.number().int().nonnegative() }).safeParse(existing);
    if (existingScreen.success) return this.desktopScreen(existingScreen.data.screen, screenCount);

    const usedScreens = new Set(this.database.query("SELECT screen FROM desktop_assignments").all()
      .map((row) => z.object({ screen: z.number().int().nonnegative() }).parse(row).screen));
    const screen = Array.from({ length: screenCount }, (_, index) => index).find((index) => !usedScreens.has(index));
    if (screen === undefined) throw new Error("All X11 screens are assigned");
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
      deliveredAt: null,
      turnId: null,
    });
    const commit = this.database.transaction(() => {
      this.database.query(`
        INSERT INTO message_envelopes
          (id, sender_id, recipient_id, text, skill_name, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        message.senderId,
        message.recipientId,
        message.text,
        message.skillName,
        message.status,
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
        skill_name AS skillName, status, created_at AS createdAt,
        delivered_at AS deliveredAt, turn_id AS turnId
      FROM message_envelopes WHERE status = 'processing'
      ORDER BY created_at, id
    `).all());
  }

  requeueMessage(messageId: string): void {
    this.database.query("UPDATE message_envelopes SET status = 'queued' WHERE id = ? AND status = 'processing'")
      .run(messageId);
  }

  claimNextMessage(agentId: AgentId): MessageEnvelope | undefined {
    const row = this.database.query(`
      UPDATE message_envelopes SET status = 'processing'
      WHERE id = (
        SELECT id FROM message_envelopes
        WHERE recipient_id = ? AND status = 'queued'
        ORDER BY created_at, id LIMIT 1
      )
      RETURNING
        id, sender_id AS senderId, recipient_id AS recipientId, text,
        skill_name AS skillName, status, created_at AS createdAt,
        delivered_at AS deliveredAt, turn_id AS turnId
    `).get(agentId);
    return row ? MessageEnvelopeSchema.parse(row) : undefined;
  }

  markDelivered(messageId: string, turnId: string | null): void {
    this.database.query(`
      UPDATE message_envelopes
      SET status = 'delivered', delivered_at = ?, turn_id = ?
      WHERE id = ?
    `).run(new Date().toISOString(), turnId, messageId);
  }

  markFailed(messageId: string): void {
    this.database.query("UPDATE message_envelopes SET status = 'failed' WHERE id = ?").run(messageId);
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
        e.created_at AS createdAt, m.status
      FROM transcript_events e
      LEFT JOIN message_envelopes m ON m.id = e.message_id
      WHERE e.agent_id = ?
      ORDER BY e.created_at, e.rowid
    `).all(agentId));
  }

  lastMessage(agentId: AgentId): AgentMessage | undefined {
    const row = this.database.query(`
      SELECT
        e.id, e.agent_id AS agentId, e.message_id AS messageId, e.role, e.direction,
        e.text, e.sender_id AS senderId, e.recipient_id AS recipientId,
        e.created_at AS createdAt, m.status
      FROM transcript_events e
      LEFT JOIN message_envelopes m ON m.id = e.message_id
      WHERE e.agent_id = ?
      ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1
    `).get(agentId);
    return row ? AgentMessageSchema.parse(row) : undefined;
  }

  lastAssistantMessage(agentId: AgentId): AgentMessage | undefined {
    const row = this.database.query(`
      SELECT
        e.id, e.agent_id AS agentId, e.message_id AS messageId, e.role, e.direction,
        e.text, e.sender_id AS senderId, e.recipient_id AS recipientId,
        e.created_at AS createdAt, NULL AS status
      FROM transcript_events e
      WHERE e.agent_id = ? AND e.role = 'assistant'
      ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1
    `).get(agentId);
    return row ? AgentMessageSchema.parse(row) : undefined;
  }

  addAssistantMessage(agentId: AgentId, text: string): AgentMessage {
    const message = AgentMessageSchema.parse({
      id: randomUUID(),
      agentId,
      messageId: null,
      role: "assistant",
      direction: "outbound",
      text,
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

  private saveProfile(profile: AgentProfile, threadId: ThreadId | null, threadConfig: string | null = null): void {
    const validated = AgentProfileSchema.parse(profile);
    const now = new Date().toISOString();
    this.database.query(`
      INSERT INTO agents
        (id, name, aliases_json, role, sandbox, instructions, thread_id, thread_config, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        aliases_json = excluded.aliases_json,
        role = excluded.role,
        sandbox = excluded.sandbox,
        instructions = excluded.instructions,
        thread_id = COALESCE(excluded.thread_id, agents.thread_id),
        thread_config = COALESCE(excluded.thread_config, agents.thread_config),
        updated_at = excluded.updated_at
    `).run(
      validated.id,
      validated.name,
      JSON.stringify(validated.aliases),
      validated.role,
      validated.sandbox,
      validated.instructions,
      threadId,
      threadConfig,
      now,
      now,
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
}
