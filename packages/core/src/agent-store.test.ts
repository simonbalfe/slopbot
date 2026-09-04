import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentStore } from "./agent-store.ts";
import { createAgentId } from "./agent-types.ts";
import type { AgentProfile } from "./agent-types.ts";

const lead = {
  id: createAgentId("lead"),
  name: "LEAD",
  aliases: ["lead"],
  role: "Coordinates",
  sandbox: "read-only",
  instructions: "Coordinate work",
} satisfies AgentProfile;
const worker = {
  id: createAgentId("worker"),
  name: "WORKER",
  aliases: ["worker"],
  role: "Executes",
  sandbox: "workspace-write",
  instructions: "Execute work",
} satisfies AgentProfile;

test("persists correlated delivery and bounds retries", () => {
  const directory = mkdtempSync(join(tmpdir(), "slopbot-mailroom-"));
  const databasePath = join(directory, "mailroom.sqlite");
  let store = new AgentStore(databasePath);
  try {
    store.upsertProfiles([lead, worker]);
    const request = store.queueMessage({
      senderId: lead.id,
      recipientId: worker.id,
      parentId: null,
      replyRequired: true,
      text: "Build it",
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
      skillName: null,
    });
    expect(store.hasPendingMessages(worker.id)).toBe(true);
    const firstClaim = store.claimNextMessage(worker.id);
    expect(firstClaim?.attemptCount).toBe(1);
    expect(firstClaim?.images).toEqual([
      { mimeType: "image/png", data: "aGVsbG8=" },
    ]);
    expect(store.listMessages(worker.id)[0]?.images).toEqual(firstClaim?.images);
    store.close();

    store = new AgentStore(databasePath);
    expect(store.listProcessingMessages()).toHaveLength(1);
    expect(store.requeueMessage(request.id, 3)).toBe(true);
    expect(store.claimNextMessage(worker.id)?.attemptCount).toBe(2);
    store.markCompleted(request.id);
    const reply = store.queueMessage({
      senderId: worker.id,
      recipientId: lead.id,
      parentId: request.id,
      replyRequired: false,
      text: "Built",
      images: [],
      skillName: null,
    });
    expect(reply.parentId).toBe(request.id);
    expect(store.hasReply(request.id)).toBe(true);
    expect(store.claimNextMessage(worker.id)).toBeUndefined();

    const failing = store.queueMessage({
      senderId: lead.id,
      recipientId: worker.id,
      parentId: null,
      replyRequired: true,
      text: "Retry it",
      images: [],
      skillName: null,
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(store.claimNextMessage(worker.id)?.attemptCount).toBe(attempt);
      expect(store.requeueMessage(failing.id, 3)).toBe(attempt < 3);
    }
    expect(store.claimNextMessage(worker.id)).toBeUndefined();
    const claimedReply = store.claimNextMessage(lead.id);
    expect(claimedReply?.id).toBe(reply.id);
    if (claimedReply) store.markCompleted(claimedReply.id);
    expect(store.hasPendingMessages(worker.id)).toBe(false);

    store.deleteAgent(worker.id);
    expect(store.getAgent(worker.id)).toBeUndefined();
    store.upsertProfiles([worker]);
    expect(store.getAgent(worker.id)).toBeUndefined();
    expect(store.createProfile(worker).profile.id).toBe(worker.id);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
