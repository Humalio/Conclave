# Early Echo evaluation

The scripted story of the Early Echo (see [docs/showcase.md](../docs/showcase.md)): the Echo Case vault, the acts, and the runner that is both Conclave's full feature test suite and the data behind console design reviews.

In a demo console, open **Explore the case**. Replay through Act 3 to investigate the vault clues and make the receiver and access decisions yourself. Replay through Act 5 to read the last station-log entry and answer Case Command's next question. A listed answer gives you a corresponding follow-up and vault note on the decision page and in the guide.

| Path | What it is |
|---|---|
| `vault/` | The Echo Case vault in its start-of-story state. `story/check-vault.mjs` checks it; `story/make-assets.mjs` regenerates its data files. |
| `run.mjs` | The runner: CLI and module (`runStory`). |
| `story/cast.mjs` | PCs, agents, teams, grants and directives. |
| `story/act0.mjs` … `act5.mjs` | The steps: `{ id, title, run(ctx), beat, rows }`. `scale.mjs` is the optional volume act. |
| `story/demo-handoff.mjs` | The interactive Act 5 handoff. It leaves live work, paper evidence, collaborator access, and security records for the demo console. |
| `story/invariants.mjs` | What must hold after each act. |
| `story/coverage.mjs` | The gate and the matrix as data: every MCP tool, admin-API area and acceptance row. |
| `story/lib.mjs`, `story/context.mjs` | Throwaway hub, admin, MCP and `/onboard` clients, the recorder, the step context. |
| `out/` | Reports (`coverage.json`, `coverage.md`, `outcomes.log`); ignored by git. |

From `server/`:

```bash
npm run story                                   # throwaway hub on 127.0.0.1, Acts 0–5, coverage gate
npm run story -- --until 2 --keep               # stop after Act 2, keep the hub for the console
npm run story -- --from 3 --until 3 --pace 1x   # replay Act 3 at watchable speed
npm run story -- --scale                        # add the volume act
npm run dev:seed                                # the same story against the running dev:hub
```

The runner talks to 127.0.0.1 only, in every mode, prints no secret, and keeps keys in memory. `npm test` runs the whole story (`server/test/eval-story.test.ts`). The graph benchmark that used to live here is in [`bench/`](../bench/README.md).
