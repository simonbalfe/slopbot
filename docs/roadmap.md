# Roadmap

Build a small, portable Pi host for one persistent bot. See the [README](../README.md) for the current terminal chat, SQLite configuration, and browser setup.

| Priority | Work | Finished when |
|---|---|---|
| 1 | Stop and steer | User input can interrupt or redirect active work through Pi's native controls. |
| 2 | Remote context | An authenticated remote provider enriches turns using a stable bot identity; durable knowledge need not live on the device. |
| 3 | Tool activity and approvals | Users can inspect tool actions and approve consequential operations. |
| 4 | Routines | The bot can run scheduled work, record outcomes, and pause routines. |

Additional bots, group rooms, multiple computers, model selection, and a plugin marketplace are deferred. One local VM is provisioned now. Keep the existing Pi session and queue mechanisms; do not build parallel execution machinery.

Validate external inputs, preserve stored conversations, and make failed context retrieval or memory writes visible. Select a license before publishing an open-source release.
