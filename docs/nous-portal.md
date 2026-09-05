# Nous Portal

SlopBot supports Nous device login and model selection using its existing Pi runtime. File and shell tools stay on the host; browser and desktop tools stay on the separate VM.

## Setup

First obtain a Nous-issued or approved OAuth client ID for SlopBot. Set `SLOPBOT_NOUS_CLIENT_ID` in the ignored project `.env`, then run `bun run runtime:restart`. This repository does not ship a registered client ID or borrow Hermes's identity. Third-party registration requirements still need confirmation with Nous; without an accepted client ID, this integration is not ready for subscriber use.

In terminal chat:

```text
/login nous
/models
/model MODEL_ID
```

Complete the displayed URL/code login before listing models. Choose an exact model ID from `/models`. Provider and model selection persist in the bot's SQLite configuration. `/login openai-codex` switches back to the default Codex model. Existing conversation history is retained.

The dashboard offers provider selection on its login page and under Settings. After signing in, open Settings, load available models, and choose one.

## Credentials and compatibility

Pi stores OAuth credentials in SlopBot's ignored state directory and refreshes them through its credential lifecycle. Tokens are never returned to the UI. Nous requests use HTTPS, reject redirects, and time out. Device polling handles pending approval, slowdown, denial, expiry, and cancellation. Refresh uses Nous's `x-nous-refresh-token` header and preserves rotated credentials.

Only the `inference:invoke` scope is requested. The legacy Hermes session-key flow is not implemented. Catalog metadata determines image support when supplied; missing limits use a conservative 32,768-token context and 4,096-token output ceiling. Reasoning extensions are disabled and pricing estimates are unavailable (internal cost fields are zero). Account entitlement and model/tool compatibility require live verification with Nous.

Implementation references: [Nous device flow](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth_device_flow.py), [Nous refresh and inference](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth_nous.py).

## Validation

Run `bun run check`, `bun apps/server/src/verify.ts`, and `bun run build`. The standalone check covers mocked device approval, denial, cancellation, refresh rotation, missing/mismatched client IDs, model persistence, and session continuity. Live Nous login and inference have not been verified without an approved SlopBot client ID and subscriber credentials.
