# Filesystem consistency

The [vault store](../server/src/vault/store.ts) coordinates hub writes and observes external ones. A revision is `sha256:<hex>` of the file bytes. A file record has a stable ID where a move can be recognized; a deletion is a tombstone. Use `absent` where a restore expects the path to be missing. History and blobs live outside the synced vault.

## Commit protocol

1. Resolve a confined path and serialize competing hub operations on the affected path or paths. Verify current permissions, write controls and the supplied `base_revision`; create expects an absent destination.
2. Preserve a supported pre-image in the blob store and record a write intent. For a replacement, stage the new bytes in a same-directory `*.hub-tmp` file and flush it.
3. Check the live target again and recheck applicable authorization and lockdown before committing. If the disk changed before this check, fail with a conflict rather than replacing it. Rename requires access on both paths and an absent destination.
4. Apply the filesystem operation, then finalize file metadata and revision history in SQLite. A SQL transaction cannot cover filesystem operations. The intent is removed only after the knowledge graph has seen the committed change. Startup recovery uses the recorded intent and actual disk state to finish an already-applied change or clean up an uncommitted write, and then reconciles the graph with the file's committed revision, including renames and deletes ([vault](vault.md#deriving-knowledge)). Running it twice gives the same result.

On conflict, reload the current revision and reconcile before retrying. A stale CAS call records a conflict; it does not promise a stored copy of arbitrary rejected client input. A detected external change during a staged replacement can retain the attempted content alongside the observed version. Use history and conflict inspection before resolving; a restore is itself a new write. A patch requires each exact old string to occur once at its step. Renaming does not rewrite backlinks automatically.

A revision names content, not a moment. If a file goes from A to B and back to A, a `base_revision` of A matches again and the write applies: the agent edits exactly the bytes it read. A base of B is refused. History keeps the round trip.

## Paths and names

- A path segment ending in a dot or a space is refused (`invalid_path`) on every platform. Windows strips them, so `.obsidian.` or `secret.md ` would otherwise reach a hidden folder or a file a rule denies. A file or folder that already has such a name (possible on Linux and macOS, or from a sync tool) is treated like a hidden one: it is not listed, scanned or indexed, so the hub never points at a path it would refuse.
- On a case-insensitive file system (NTFS, APFS), a file is reachable only under its name on disk. A case variant (`NOTE.md` for `Note.md`) is refused: a read as `denied`; a write, delete or rename as `conflict` with `reason: "case_mismatch"` and the real path. Path rules compare names exactly, so a variant must not sidestep them, and the store keeps one record per file. A case-only rename (`Note.md` to `note.md`) moves that record.
- Just before staging, committing, deleting or renaming, the store checks again that each parent folder is a real folder, not a symlink or junction swapped in since the path was resolved. A swap in the last instant can still race the operation itself: Node has no `openat` or `O_NOFOLLOW` to close it.

## History across renames

A revision is recorded with the path the file had at the time. `file_history` lists, `file_diff` compares and `file_restore` brings back only revisions recorded at a path the caller may see: `fs.history` to list, `fs.history` and `fs.read` to diff, `fs.read` to restore. Anything else answers `not_found`. `file_history` filters the newest 1,000 revisions of a file; diff and restore check the requested revision directly, however old it is. After a file moves out of a folder, that folder's readers lose its history: the old path has none, or only that of a new file there. A reader of both folders keeps the whole history. A reader of only the new folder sees revisions from the move on.

## External writers and limits

A watcher plus a periodic scan (60 seconds by default) records observations, using size and mtime to avoid rehashing unchanged entries. It recognizes supported sync conflict copies and can infer a move from a matching disappearance and appearance by hash. Observations cannot name a writer or recover every intermediate version. Keep the vault on local disk where practical, exclude `*.hub-tmp` from sync, and enable independent versioning on the sync side.

An external process can still write between the final check and replacement. Hub locks only serialize hub operations, and a sync rename can race with the destination check. Neither hash checks nor an atomic rename provide distributed locking. Parent directory flushes are best effort where the OS does not support them.

The store bounds writes and history: text write input up to 2 MiB, supported pre-images up to 16 MiB, observed external text blobs up to 2 MiB, tracked files up to 64 MiB. Some large or binary files have metadata without recoverable content. Unreferenced blobs are eligible for retention cleanup; referenced history can continue to grow. See [vault](vault.md) for discovery and [risks](risk-register.md) for deployment implications.

## Outcomes and conflict records

A validated request can proceed to the write protocol. A returned revision records a completed local write. A watch or scan event establishes an observed local state. Confirmation of remote replication requires separate evidence from the sync system.

Conflict records distinguish a stale base (`platform_cas`), a change during staging (`external_during_commit`), and a recognized conflict copy (`sync_tool`). They identify the file, expected base and available competing revisions. Operators can choose a retained revision in the conflict view. To merge, read the available versions and write the reconciled result against the latest base. History and blobs can retain sensitive content after deletion.

A person's save in the console is the one exception to recording a stale base: when its base no longer matches, nothing is written and no `platform_cas` conflict is recorded, because the editor itself shows the change and asks the person to reload, copy their text or keep theirs ([vault](vault.md#people-writing-in-the-vault)). Keeping theirs is a new write with the base just read. An `external_during_commit` change during a console save is still recorded. Agents' stale writes are recorded as before.

Validate scan fallback on network mounts. The size and mtime check can miss changes that preserve both. Test case, Unicode, junction and symlink behavior on the filesystems you support. The [regression tests](../server/test/vault-unverified.test.ts) cover case variants, trailing dots and spaces, and junction swaps on the platform that runs them.
