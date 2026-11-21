# Vault stress cases

Re-runnable checks for the vault: concurrent writers, conflicts, odd names and sizes, cut-off writes, access rules, external edits, restore, a revoked key and restricted folders under load. Each case prints `PASS` or `FAIL` with evidence and writes a JSON file.

**Run these only against a demo or test hub, never a live one.** They create thousands of files under `Stress/`, and one case restarts the hub. Take a backup first. No host, key or password is stored in these files: all of it comes from the environment (see the top of `lib.mjs`).

## Steps
1. On a test hub, pair a PC (any) and note its app key id and secret. In the console, nothing else is needed.
2. Create the agents and keys. They are written to `STRESS_SECRETS` (mode 600; do not commit it):
   `STRESS_CONSOLE_URL=… STRESS_ADMIN_USER=… STRESS_ADMIN_PASSWORD=… STRESS_APP_KEY_ID=… STRESS_APP_KEY=… node eval/vault-stress/setup.mjs`
3. Run: `STRESS_MCP_URL=http://<hub>:<port>/mcp STRESS_CONSOLE_URL=… STRESS_ADMIN_USER=… STRESS_ADMIN_PASSWORD=… node eval/vault-stress/run-all.mjs`
   Optional: `STRESS_RESTART_CMD` (a command that restarts the hub, enables case 4e), `STRESS_HOST_SHELL` and `STRESS_VAULT_DIR` (a shell on the hub host and the vault folder there, enables c5), `STRESS_INSECURE_TLS=1` for a hub with a private CA.
4. After a run, check the disk against the index inside the hub container: `docker cp eval/vault-stress/verify.mjs <container>:/tmp/ && docker exec <container> node /tmp/verify.mjs Stress`. It must report no orphans, no missing rows, no hash mismatches, no leftover `*.hub-tmp` and no open write intents.

## Cases
| File | What it checks |
|---|---|
| `c1-writers` | 2, 5 and 20 writers on one base revision (one winner); read-modify-write appends with retry (no lost update) |
| `c2-conflicts` | edit vs delete, edit vs rename, rename vs rename to one target, create vs create, rename of a folder, edits racing a rename chain |
| `c3-names-sizes` | case, NFC/NFD, spaces, emoji, RTL, bidi, long names, traversal and forbidden folders, 1 MiB and over-limit writes, odd content (NUL, lone surrogate, BOM, line endings) |
| `c4-cutoffs-access` | read-only, no-rights and restricted agents; clients killed mid body; aborted creates; hub restart in the middle of a burst |
| `c5-external` | disk edits, deletes and renames made outside the hub; console save vs agent update |
| `c6-console-restore` | console save vs agent update ×5, delete then restore |
| `c7-sync-churn` | churn generator for the `conclave sync` checks (below), not a pass/fail case |
| `c8-revoke-restricted` | a key revoked mid burst; 20 parallel requesters against restricted folders |

## `conclave sync` checks (by hand)
Create a vault reader on the test hub for `Stress/**`, run `conclave sync add` on a throwaway PC, wait for the first sync, then run `c7-sync-churn.mjs` and compare the hub's `Stress/` with the mirror by hash a minute later (they must be equal). Also: edit a mirror file locally (the next hub change keeps your edit in `.conclave-trash`), add a new local file (`sync list` must say so), pause and resume, and try a second sync into the same or a nested folder (refused).

## Audit
After a run, the hub's audit log must hold a `vault.file.*` row for agent writes and a `vault.file.refused` row for refused ones, and every file revision must name its author.

## Limits to know
- A full run opens about 80 agent sessions. The hub allows 100 live sessions per app key (`rate_limited: this app already has 100 live sessions`), so a second run right after the first needs a fresh PC app key (rerun `setup.mjs` with it) or a wait until the sessions expire.
- Each run writes into its own folder `Stress/<run id>/` (set `STRESS_RUN` to choose the id), so reruns never meet each other's files. The restricted-folder cases use `Stress/Open/` and `Stress/Closed/` with run-stamped file names.
