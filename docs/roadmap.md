# SlopBot roadmap

SlopBot should remain a small multi-bot app: persistent bots, private conversations, durable handoffs, and one computer they can use.

## Working now

- Multiple bots with stable identities and separate Pi sessions.
- A default `lead` and `worker`, plus user-created bots.
- Durable asynchronous bot-to-bot requests and correlated results.
- Private transcripts with visible message delivery state.
- Retry and restart recovery for interrupted messages.
- One shared Linux computer with a persistent browser and desktop.

## Next

1. Let users stop or redirect active work.
2. Add clear approval prompts for consequential actions.
3. Add small, scoped memories that preserve private conversations.
4. Add routines for scheduled work.
5. Give each bot its own browser profile and session inside the same shared VM.

## Invariants

- A user message takes priority over internal work.
- A queued message survives restart and wakes its recipient no more than once.
- Every bot keeps its own private transcript.
- Bots communicate through explicit messages, keeping shared context intentional.
- The host validates state changes and external actions.
- The interface keeps runtime internals out of the user's way.
