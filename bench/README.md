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

See the [vault knowledge graph guide](../docs/vault.md) for the behavior the benchmark exercises.
