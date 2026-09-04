# Roadmap

SlopBot is building an open-source take on Grok Bot: agents with private conversations, reliable handoffs, browser access, and shared project work. The Grok Bot agent blueprint is design inspiration, not an upstream specification.

See the [README](../README.md) for what works today and how to run it.

## Next steps

Work in this order:

| Priority | Work | Finished when |
|---|---|---|
| 1 | Message recovery | An automated runtime test verifies that queued handoffs survive a restart and completed work is not repeated. SQLite tests already cover correlation, persistence, retries, and duplicate results. |
| 2 | Scheduling and cancellation | User tasks take priority over internal work. Bots can cancel background work without it silently resuming. |
| 3 | Scoped memory | Bots can save facts with a source and an owner, then retrieve relevant agent, user, or project memory within a prompt budget. |
| 4 | Permissions and audit | Users can allow or deny a specific action, approvals expire at the right scope, and decisions appear in an audit log. |
| 5 | Group rooms | Bots can discuss a task in a shared room without exposing private chats. Rooms stop after 3 rounds, 10 messages, or a round with no useful contribution. |
| 6 | Agent and browser management | Users can edit and disable bots, browser capacity is visible and queued, and concurrent file edits have ownership or isolation. Creating and deleting bots already works. |
| 7 | Models and skills | The runtime supports additional providers, usage tracking, cancellation, and skills assigned per bot. Today it uses Pi with OpenAI Codex. |

## Rules for new features

- Protect active user work from internal interruptions.
- Preserve queued messages and prevent duplicate work during recovery.
- Keep private chats and memory private unless explicitly shared.
- Validate actions in the host and record authorization decisions.
- Make cancellation final unless work is explicitly resumed.
- Treat browser profiles and filesystem isolation as separate concerns.

These are development requirements. Scheduling, scoped memory, and approval controls are still planned work.

## Open-source release

- Select and add a license.
- Make the local Leads CLI mounts optional so a fresh clone runs without personal repositories or skills.

Unlimited bot meetings, shared private transcripts, automatic permanent permissions, and dynamic cloud provisioning are outside the current scope.
