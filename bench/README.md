# Graph benchmark

The benchmark fixture is generated on demand.

From the repository root, build the server and generate the benchmark fixture:

```powershell
npm --prefix server ci
npm --prefix server run build
node bench/tools/build.js
```

The generator checks the notes, evidence, and task setup. It writes the vault, tasks, and manifest under `fixture/` in the `EVAL_WORK` directory. By default, that directory is `agent-hub-eval` in the OS temporary directory. Runtime state and reports also live there. The harness generates missing fixture data automatically.

- `node bench/harness/det.mjs` runs deterministic scenarios against a disposable hub.
- `node bench/harness/hub.mjs up <task-id|all>` starts a local benchmark hub on port 18090. Use `node bench/harness/hub.mjs down` to stop it.
- `node bench/harness/live.mjs` runs the agent evaluation using Claude Code and the harness budget. Set `EVAL_CLAUDE_BIN` to override the executable.
- `node bench/harness/report.mjs` assembles a report from local results.

## Tokens for one task

`node bench/harness/tokens.mjs` measures what one task really costs in Codex and in Claude Code. It starts a disposable hub on port 18090 and runs four turns per client: the worker submits, the reviewer requests changes, the worker resubmits after a restart, and the reviewer approves. It records the provider's input, output and cached tokens next to the hub's calls, reply bytes and time to verdict, and writes only numbers to [`tokens.md`](tokens.md) and `tokens.json`.

- `--clients codex,claude` picks the clients; both run by default.
- `--cap 400000` stops a run once its input and output tokens pass that number (or set `TOKENS_CAP`); `--turn-seconds 600` stops a slow turn. The cap is checked after each provider report, so the request that crosses it still completes.
- A turn whose client exits before its first request is tried once more.
- `--table-only` rewrites `tokens.md` from `tokens.json` without starting a hub or a client.
- `TOKENS_CODEX_BIN` and `TOKENS_CLAUDE_BIN` override the executables; `--claude-model` (default `sonnet`) and `--codex-model` pick the models.

Both clients must already be signed in. The script never prints keys. It deletes its keys file, the throwaway hub's state file and its cached tokens when it ends, also on Ctrl+C, and sweeps any a killed run left behind when it starts. The hub commit in the table is the last commit that changed `server/`.

See the [vault knowledge graph guide](../docs/vault.md) for the behavior the benchmark exercises.
