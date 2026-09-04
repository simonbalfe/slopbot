# SlopBot roadmap

This roadmap adapts the repository-grounded ideas in *The Grok Bot Agent Blueprint* to SlopBot. The blueprint describes an unofficial reconstruction, so it is design input rather than an upstream specification.

## Target

SlopBot should be a small, model-independent agent host built from stable identities, private transcripts, durable asynchronous messages, explicit run scheduling, scoped memory, isolated browser sessions, and auditable permissions.

Status labels: **Done** is working now, **Partial** has a usable foundation but does not meet the milestone acceptance tests, and **Todo** has not been implemented.

## Current baseline

| Layer | Status | Current implementation |
|---|---|---|
| Interface | Partial | React chat, agent status, settings, and live browser views |
| Identity | Strong | Stable IDs, profiles, aliases, roles, private Pi sessions, and transcript ownership |
| Messaging | Strong | Durable correlated envelopes, FIFO inboxes, bounded retries, completion state, visible delivery status, hidden wakes, and restart recovery |
| Orchestration | Basic | One serial run per agent with `idle`, `running`, and `error` state |
| Memory | Missing | Pi transcripts persist, but there is no separate durable memory service |
| Computer | Strong | One SlopBot-owned browser runtime and persistent login profile per assigned agent; workspace files remain shared |
| Permissions | Weak | Tool schemas validate input, but runtime approval is `never` and browser-enabled agents currently receive full container access |
| Model | Partial | Pi wraps the OpenAI Codex provider, but SlopBot does not yet expose a provider-neutral adapter contract |

## Milestone 1: reliable direct messaging

Make the existing mailroom trustworthy before adding more coordination primitives.

- **Done:** Replies carry the parent message ID that caused them.
- **Done:** SQLite distinguishes accepted, running, completed, and failed delivery; completion is recorded only after the turn completes.
- **Done:** Running messages have a five-minute lease, a three-attempt limit, and restart recovery.
- **Done:** Peer requests require one correlated result, failure, or pass response and reject duplicate results.
- **Done:** The chat UI shows accepted, running, completed, and failed message state.
- **Partial:** The SQLite integration test covers correlation, persistence, bounded retries, and deduplication. A live Pi wake and restart pass was verified manually; automating that runtime path remains.

Acceptance:

- Agent A sends to Agent B without blocking.
- B wakes once, processes the request, and sends a correlated result on a later turn.
- Restarting the host loses neither queued work nor completed delivery state.
- Duplicate recovery never produces duplicate agent work.

## Milestone 2: run lanes and cancellation

- **Todo:** Persist run records with `user`, `agent`, `automation`, and `background` lanes.
- **Partial:** Each agent serializes its FIFO inbox and peer messages wait behind active work, but user work is not represented as a protected lane.
- **Todo:** Add priority one-to-one messages with a small set of reasons.
- **Todo:** Allow priority traffic to supersede only non-user work.
- **Todo:** Record cancellation reason, partial-result disposition, and whether superseded work may resume.

Acceptance:

- Normal peer messages wait behind active work.
- Priority peer messages may cancel non-user work but never interrupt a user turn.
- Cancelled work cannot resume silently.

## Milestone 3: scoped memory

- **Partial:** Profiles and private transcripts are separate, but there is no memory record yet.
- **Todo:** Add `profile`, `log`, and `note` tiers.
- **Todo:** Add `agent`, `user`, and `project` scopes with explicit ownership.
- **Todo:** Retrieve a ranked, token-budgeted memory view for each turn.
- **Todo:** Record the source of every stored fact.

Acceptance:

- Private agent memory never enters another agent's prompt by default.
- Shared project memory is retrieved only for the active project.
- Prompt construction stays within a configured memory budget.

## Milestone 4: permissions and audit

- **Todo:** Replace blanket runtime approval with `always`, `ask`, and `never` policies.
- **Todo:** Add scoped `allow once`, `deny`, `always allow`, and `never allow` decisions.
- **Todo:** Bind approvals to agent, action, target, run, and expiry.
- **Done:** Agent actions run in SlopBot-owned Docker browser runtimes; no tool currently exposes the user's Mac directly.
- **Partial:** Typed schemas validate host tool calls, but side effects and authorization decisions are not stored in an audit log.

Acceptance:

- Allow-once expires with its run.
- Never blocks the action without asking again.
- A denial cannot cause an immediate approval loop.
- The UI shows the exact action and target before approval.

## Milestone 5: bounded rooms

- **Todo:** Add shared room transcripts without exposing private chats.
- **Todo:** Support mentions, rotating speaker order, and `(pass)`.
- **Todo:** Stop after 3 rounds, 10 total messages, or no useful message in a round.
- **Todo:** Invalidate stale room work with an orchestration epoch.

Use rooms only for multi-party judgment. Keep clear handoffs as direct messages.

## Milestone 6: scalable agents and work surfaces

- **Todo:** Let users create, edit, disable, and delete agents through the typed API and UI.
- **Todo:** Provision or queue browser sandboxes when agent count exceeds current capacity.
- **Partial:** SQLite persists sandbox assignments and the UI exposes each login view, but capacity and availability are not modelled as states.
- **Todo:** Add file ownership, worktrees, or locks when agents write concurrently.
- **Done:** Each assigned agent has a separate persistent browser profile while all agents share the documented workspace mount.

## Milestone 7: adapters and workflows

- **Partial:** `PiRuntime` isolates model operations from orchestration, but its contract still contains Pi and Codex-specific behavior and lacks usage and cancellation.
- **Partial:** Pi discovers skills with paths and working directories, but all enabled skills and host tools are currently global rather than assigned per agent.
- **Todo:** Import external instruction formats through explicit adapters.
- **Todo:** Preserve source metadata and never execute imported scripts during discovery.

## Invariants

1. A user's active turn outranks internal work.
2. A queued message survives restart and wakes its recipient no more than once.
3. Private transcripts and agent memory remain private by default.
4. Models propose actions; the host validates and commits state changes.
5. External or destructive actions require an authorization decision and audit event.
6. Runs and rooms can be cancelled without hidden work resuming later.
7. A private browser does not imply a private filesystem.

## Not planned yet

- Unlimited autonomous meetings.
- Shared transcript context across all agents.
- Automatic permanent permissions learned from repeated approval.
- Dynamic cloud provisioning before local scheduling and recovery are reliable.
