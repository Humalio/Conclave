# Run the hearing

This demo has two tracks. The main hearing uses four agent conversations and the console. The optional graph curator and two-PC bridge shots can be recorded separately. The showpiece is the argument changing in response to evidence.

## Preloaded WSL showcase

At `http://localhost:8080`, open **Agents → Topology → All**. The two teams and three assignments are already set up. Arden is Chair, Ilex argues for withdrawal, Nacre argues for the witness, and Vela reviews both briefs. Tess runs the optional evidence check.

The deployment keeps the local MCP app key and individual session handoffs in `~/.local/share/conclave-demo/rehearsal-handoffs.json` inside WSL. Use the app key in the MCP configuration for the rehearsal client, then give each session only its own session key and role. Keep this file out of recordings. Start the connected sessions at **Act I** below and use the assigned tasks on the existing board.

## Prepare

Use these steps for a fresh installation that has no rehearsal roster.

1. Copy `demo/vault/` to a disposable location. Start Agent Hub with that copy as `VAULT_DIR` and use the default alias `vault`. Keep the watcher enabled. Open the same copy in Obsidian. See the [hub quickstart](../docs/getting-started.md).
2. Make four independent sessions named **Chair**, **Withdrawal**, **Witness**, and **Reviewer**. Connect from configured desktop apps. Keep all key issuance, handoff, and token screens out of capture. Tell each session to log in, read `/vault/Hearing/Roles at the Hearing.md` and `/vault/Hearing/Hearing Brief.md`, and act only in the assigned seat.
3. Create and start **The Last Playback**. Set Chair as coordinator, both advocates as workers, and Reviewer as reviewer. Enable team messaging. Enable the `done` checkpoint if you want the operator to make the closing approval on camera. Keep the four participants on the board, even if two share a PC.
4. Scope grants explicitly. A full-vault Reader template would expose the sealed exhibit. Remove any broad allow before issuing a handoff. Use the same bounded policy for each advocate so neither starts with privileged evidence.

| Seat | Standing vault access | Extra grants for featured shots |
|---|---|---|
| All four | `fs.list` on `path:/vault` and list/read/search on `Cases/**`, `Evidence/**`, `House/**`, `Hearing/**`, `Debate/**`, `Assets/**`, and `Start Here.md` under `path:/vault/`. | `tool.invoke` on `tool:file_*` and `tool:graph_*`. Resource gates still apply. Team-generated actions cover assigned team work and enabled messaging. |
| Advocates | Add create/update on `path:/vault/Debate/**` if briefs are written directly. | For versioned briefs allow `tool:share_*` invocation and `share.create`, `share.upload` on `share:*`. |
| Reviewer | Read standing sources and working notes. | Allow `tool:share_*` invocation and `share.read`, `share.comment`, `share.suggest` on `share:*`. Explicitly verify author-to-reviewer messaging reach before sharing. |
| Chair | Create/update/history in `Debate/**`. Add `fs.history` on the exact intake path to inspect the diff. | Leave `/vault/Sealed/**` without an allow. Use temporary approval for the exact exhibit during the reveal. |
| Optional transfer seat | Allow `fs.read` and `fs.download` on `path:/vault/Assets/R-17 Audio Reconstruction.wav`. | Grant the channel tool invocations, `channel.use` on `channel:*`, and scoped peer `channel.open` and `channel.accept` for an agent-to-agent relay. Pair bridges and approve dedicated local inbox and export folders. |

Resource patterns in the table are shorthand. For example, use `path:/vault/Evidence/**` for an Evidence rule and `tool:file_*` as the resource of a `tool.invoke` rule. Check each login using the console simulator and an actual tool call. A targeted approval cannot override an explicit deny. Refer to [authorization](../docs/authorization.md) and [MCP](../docs/mcp.md).

## Act I · The hearing opens

- Chair creates two tasks, each with the independent reviewer assigned. The workers claim or start them, post contrasting openings in the room, and respond to each other's strongest claim. Chair asks both to distinguish retention from playback.
- Each advocate cites a testimony, the transcript, and the charter. At least one should use a precedent. Ask both to cite the same moment at `00:18` and tell you what it cannot establish.
- For a share shot, Witness creates a share addressed to Reviewer and uploads a Markdown brief with `final: true`. Reviewer posts a line comment on the premise about the return instruction. Witness publishes v2 after the reveal. Use the published share and version IDs when attaching the exhibit to `task_submit`. For a shorter take, use a working note in `Debate/` instead.

## Act II · A fact changes

1. Chair tries to read `/vault/Sealed/Contact Sheet R-17.md`. Capture the denial. Chair calls `access_request` with `actions: ["fs.read"]`, `resource: "path:/vault/Sealed/Contact Sheet R-17.md"`, a hearing reason, and `duration: "30m"`. Approve only that path. Chair reads the exhibit and posts a short authorized factual summary to the room. Do not broaden the other seats' grants.
2. In Obsidian edit only this line in `Evidence/Intake R-17.md`.

   ```diff
   -Return instruction object: preservation copy.
   +Return instruction object: recorder chassis.
   ```

   Save. Wait for the change in Vault Activity. This is an external edit. The earlier revision should remain available. If watching is unavailable, wait for the periodic scan and record the shot once it appears.
3. Use `file_history` and `file_diff` on the intake. Run `graph_impact` using the new revision. The seeded links point to `Initial Finding`, `Two Precedents`, the main case and the hearing brief. Confirm the notes against their text. A candidate is a place to check, not a verdict. Use a permitted session and show its actual tool result. For `graph_context` with semantic claims, prepare an eligible curator in advance and confirm coverage. Deterministic impact does not need a curator.
4. Each advocate amends the brief. The correction weakens any argument that the return instruction itself governs the recording. The privacy rule, competing petitions, and ambiguous sound remain. Require one revised premise, one surviving argument, and one unanswered question. Reviewer requests changes if a brief confuses the object correction with permission to play the recording.

## Act III · The hearing closes

- Reviewer approves supported arguments after independent review. Chair proposes a decision that records common ground and a dissent. A defensible interim action is to keep playback sealed while leaving retention contested. A different supported outcome is welcome.
- Chair writes `Debate/Decision Record.md` with the revision returned by a fresh read. Capture the audited change. If using the checkpoint, show the operator approving the completion. Approval confirms the workflow step and can coexist with a minority report.
- For an alternate safety shot, attempt an update to the **working note** using a stale revision after a second edit. Capture the conflict, then reread before retrying. Alternatively enable vault write lockdown, show an authorized draft write blocked, and lift it from the console before resuming. Use disposable state for both.

## Separate bridge shot

Ask a permitted seat to `file_download` the synthetic WAV to an absolute path under its PC's approved export folder. After completion, have that bridge offer the saved file to a second paired PC using `channel_open` with `local_path`. The recipient accepts to an approved inbox. Capture the offer, accept, progress and completed receipt. Compare the received file's SHA-256 with the original. The model can work from the transcript while the bytes travel through the bridges.

For a one-PC rehearsal, show the vault-to-PC download only. Do not label it a two-PC relay. Use [bridge setup and recovery](../bridge/README.md) for local checks.
