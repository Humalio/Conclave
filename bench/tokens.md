# Tokens for one task

One task on a disposable local hub: assigned, submitted, changes requested, resubmitted after a restart, approved. Four turns per run, started by `node bench/harness/tokens.mjs`. Numbers only; see the notes below the table.

| Date | Hub commit | Client (model) | Approved | Token cap | Input tokens | of which cached | Output tokens | Tool calls (client) | Hub calls | Hub reply bytes | Hub estimate (bytes ÷ 4) | Seconds to verdict | Reply part the client passed on |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-19 | `fe784aa` | codex (default) | yes | 400k (reached) | 456k | 394k | 1251 | 13 | 15 | 30k | 7565 | 53 | both 13 |
| 2026-11-19 | `fe784aa` | claude (sonnet) | yes | 600k (reached) | 614k | 604k | 1268 | 11 | 13 | 23k | 5727 | 29 | structured 11 |

**Notes**
- Input tokens are what the provider reports, cached included (Claude Code: input + cache read + cache write; Codex: `input_tokens`, which includes `cached_input_tokens`). Output includes reasoning tokens.
- The hub estimate counts only the hub's replies; the provider number also counts the client's system prompt, tool definitions, the prompt and every resend of the conversation. The gap between the two is what the hub telemetry cannot see.
- At hub commit `fe784aa` the hub's tool list (names, descriptions, schemas) was 109k bytes, about 27k tokens; a client sends it with every request, so it is part of each turn's input.
- "Token cap": the run's limit on input and output tokens; "(reached)" means the run passed it, after the verdict when Approved says yes. The cap is checked after each provider report, so the request that crosses it still completes.
- "Reply part": Claude Code is read from the tool results in its stream; Codex from its `mcp_tool_call` events, which carry both parts of the reply.
