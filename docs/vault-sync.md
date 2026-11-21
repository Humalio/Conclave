# Vault sync, hub side

A **vault reader** lets a PC keep a read-only copy of part of the vault (a mirror). This page is the hub's half: who the
reader is, what it may see, the change feed it follows, the hint that wakes it, and what is audited. The connector's half
(writing files, path rules per operating system, the trash) is a later task and follows the "Spec review" of the design.

## Identity

- A reader is a **teamless vault agent**: an ordinary agent with no team, an owner (a console user), and one session key
  that is bound to one PC. It is not a new kind of key.
- The key can never log in to Conclave as a working agent: `session_login` refuses it. It only calls the vault-sync routes below.
- A reader has a name, its PC, a scope, and a state: `pending` (the pairing code is not used yet), `active`, `paused` or
  `removed`. The console lists each reader with its name, PC, scope, last sync, files and bytes, and offers **Pause**,
  **Edit** (the scope) and **Remove**. Remove revokes the key: the reader's next request is refused.
- **Pairing.** Creating a reader shows a single-use pairing code (`cnv_vsync_` and 26 base32 characters), once. It follows
  the enrolment-code rules (docs/onboarding.md): the hub keeps only a keyed hash of it, it is redeemed with a nonce so a
  lost response can be retried, a code handed out three times without confirmation is refused, failed attempts from one
  address are rate limited, it can be revoked while unused, and confirming ends it. Redeeming it returns the reader's key.

## Scope is policy

- The scope is the reader key's **ordinary policy rules** (allow rules on `path:/vault/…`, plus any deny rules). There is no
  separate list of globs.
- Every decision is the one `file_read` makes: the reader's rules, deny rules, the hidden and restricted folders, the
  `99 Conclave` folder, and the owner's ceilings. A file is in scope when the reader may `fs.read` **and** `fs.download` it,
  because mirroring a file is an **export**: it needs `may_export` on the owner's grant (`fs.download`).
- Reader rules are **read-only in code**: only `fs.list`, `fs.read`, `fs.search`, `fs.history` and `fs.download` may be
  allowed. Any rule naming another action is refused, whoever edits it (the vault-sync console, the keys API, a template).
- When the owner is an external user, every file the reader downloads is audited as `export.read` (kind `vault_file`, path,
  bytes), as an external member's own download is.

## The change feed

- Paths in the feed and in downloads are **relative to the vault's root** (`Notes/A/one.md`); the rules that decide them name
  `path:/vault/Notes/A/one.md`.

- Every vault revision gets a sequence entry in `vault_changes`: a hub write, rename or delete, and also what the hub sees
  from outside (the watcher, the 60 second scan, an inferred move, crash recovery). Each entry has a kind (`put`, `delete`,
  `rename`), the path, and for a rename the old path.
- A reader never sees that sequence. It holds its own **opaque cursor**, an encrypted token that carries the position and
  a fingerprint of the reader's rules (its own and its owner's ceilings). A reader cannot read, guess or forge a position.
- `GET /vault-sync/v1/changes?cursor=…&limit=…` returns the in-scope changes after the cursor and a new cursor. The
  current rules are checked **on every page**. A change outside the scope is not returned and leaves no gap, because the
  new cursor moves past it and says nothing about how far.
- **A rename across the edge of the scope is never shown as a rename.** Both ends in scope: `rename`. Only the old path in
  scope: `delete` of the old path. Only the new path in scope: `put` of the new path. Neither: nothing.
- **A scope edit** (an added or removed rule, a deny rule, an owner ceiling change) changes the fingerprint. The old cursor
  then gets `{reset: true}` and a new cursor, and no entries: the reader lists its scope again
  (`GET /vault-sync/v1/files`), keeps what is there and deletes what is not. A file that left the scope is therefore a
  delete, never a path that moved.
- `GET /vault-sync/v1/files/content?path=…` downloads one file. It re-checks the current rules, the key and the PC first.
  A file the rules no longer allow is refused (`403`) at once, even if the reader listed it a moment ago.
- A request with a key that was revoked, a reader that is paused or removed, or a suspended PC is refused (`401`).

## The hint

- When a change in a reader's scope happens, the hub sends one `vault_changed` event on the PC's push stream
  (`{"reader": "<id>"}`, no paths), at most **one every 2 seconds per reader**, coalescing several changes into one.
- No hint is sent for a change outside the scope, so the timing of the stream tells a reader nothing about the rest of the vault.
- The hint is only a nudge: the reader asks `changes` after it, and also on its own timer.

## Audit

- One audit entry per sync run: `vault_sync.run` with the reader, the number of files and the bytes it took (the reader
  reports a run with `POST /vault-sync/v1/runs`; the hub counts what it served and keeps the larger figure it can verify).
- Per file, for an external owner: `export.read`.
- Creating, pausing, resuming, editing the scope of, pairing and removing a reader are audited too.

## Version 1 only

The routes live under `/vault-sync/v1`. A reader announces `version: 1`; anything else is refused. The mirror is read-only:
the hub has no route by which a reader writes to the vault.

## Hub routes

| Route | Who | What |
| --- | --- | --- |
| `POST /vault-sync/v1/pair` `{code, nonce}` | the code | the reader's key, the hub URL, the reader id |
| `POST /vault-sync/v1/pair/confirm` `{nonce}` | the nonce | ends the code |
| `GET /vault-sync/v1/files?cursor` | reader key | the in-scope files (paged) and a first cursor |
| `GET /vault-sync/v1/changes?cursor&limit` | reader key | in-scope changes, a new cursor, or `reset` |
| `GET /vault-sync/v1/files/content?path` | reader key | one file's bytes |
| `POST /vault-sync/v1/runs` `{files, bytes}` | reader key | one audit entry for a finished run |
| `GET/POST /api/vault-readers`, `PATCH/DELETE /api/vault-readers/:id`, `POST …/pause`, `…/resume` | admin | the console's list, create, edit scope, pause, remove |

## Console page

The console's **Vault → Readers** tab (`#vreaders`) is the administrator's page for readers; it uses only the admin routes above.

- The list is dense: one two-line row per reader (name and state; PC, scope, last sync, files, size), with a **Large** chip when a mirror is over 1 GiB or 50,000 files.
- **Add reader** takes a name, a PC, the owner, the folders it may mirror and the folders it never may. These become ordinary allow and deny rules. The sheet then shows the pairing code once.
- Tapping a row opens the reader: **Pause** or **Resume**, **Edit scope**, and **Remove**. Remove asks once more, then revokes the key, so the reader's next request is refused.
- At phone width the list and sheets fit with no sideways scroll, and Add reader sits above the tab bar.

## The connector side: `conclave sync`

The connector keeps a folder on the PC as a **read-only mirror** of a reader's scope. It runs inside the connector's service
(no new program, nothing to keep open) and uses only the routes above.

```
conclave sync add <hub> <folder> [--name <n>]   the pairing code is read from standard input (never an argument)
conclave sync list [--json]                     each sync: name, hub, folder, state, last run, files, size, local edits, new local files, warnings
conclave sync pause <name> | resume <name>
conclave sync remove <name>                     forgets the sync and its key here; the folder stays
```

- **Adding.** The operator adds the reader in the console and gives the PC user its pairing code. `sync add` redeems it
  over the hub's pinned connection, keeps the reader's key in the connector's key file under the label `vsync-<id>` (so, at
  the hardened level, in the key service), confirms the code, and records the sync in `syncs.json`. `<hub>` is a hub id or
  origin the PC is already paired with.
- **First run.** A full listing, then a download of each file whose local content hash differs from the hub's revision (the
  revision is `sha256:<hex>` of the content). The first listing's cursor is where following starts.
- **Following.** On a `vault_changed` hint on the push stream (or every 60 s when the stream is down) the connector asks for
  `changes` after its cursor and applies them. A full re-check by hash runs once a day, and whenever the hub answers
  `reset` (a scope edit, an unusable cursor), which lists the scope again, keeps what is still there and removes what is not.
- **Writing.** Each download goes to a temporary file in the same folder, is checked against its revision, then replaces the
  target atomically. A hub rename is a local rename. The mirror's own bookkeeping is in the connector's folder, not in the mirror.
- **Nothing is lost.** A file deleted on the hub or out of scope, and a local edit about to be overwritten, goes to
  `<folder>/.conclave-trash/<date>/` (an edit as `name (local <date>).ext`). Trash older than 30 days is emptied, and the
  trash is also held to the size cap by emptying the oldest day first. Files that exist only locally are never touched; `sync
  list` counts local edits and warns about each file created in the mirror folder that the hub does not have (it is never
  uploaded, and a hub file with the same name later replaces it, keeping yours in the trash).
- **Limits.** A file over 64 MiB is skipped and reported (the hub does not track it), and a sync stops taking files at its
  size cap (5 GB by default) and reports it, which the console shows as a warning.
- **Path safety.** Every hub path is checked before anything is written; a refused path is reported and nothing is written.
  - On every system: not absolute, no `..` or `.` part, no empty part, no control character or backslash, no part longer than
    255, nothing inside `.git`, `.obsidian`, `.conclave-trash` or `.conclave-sync`. Real paths are resolved: the connector never
    writes through a symlink or junction, and never outside the folder.
  - On Windows also: none of `: * ? " < >` and `|`, no part ending in a dot or a space, no reserved name (`CON`, `PRN`, `AUX`,
    `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, `CONIN$`, `CONOUT$`) with any extension, and long paths use the `\?\` form.
  - Names that differ only by case (Windows, macOS) or by Unicode form (NFC and NFD) collide: both are reported and neither is written.
  - The sync folder must not overlap the connector's home, an agent's folder or another sync. The transfers guard that protects the connector's own folder now covers its home (`CONCLAVE_HOME` or `~/.config/conclave`) as well as the bridge folder (review blocker B2).
  - The folder itself may not hold or sit inside the connector's folder, an agent's folder or another sync's folder.
- **After a revoke.** When the hub answers 401 (the reader was removed or its key revoked, or the PC suspended) the sync stops,
  `sync list` says so, and the mirror and trash stay on disk for the PC user to delete or keep.
