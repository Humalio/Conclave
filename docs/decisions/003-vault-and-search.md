# ADR-003: Disk owns vault contents

**Context.** People and external sync tools edit the same Obsidian files as the hub. The hub cannot require a distributed lock or make SQLite the owner of live document bytes.

**Decision.** Use content-hash revisions, compare-and-swap writes, same-directory staging and a recovery journal. Keep version blobs outside the vault. Observe external changes with a watcher and scan. Use bounded text scans filtered by the caller's grants; add an index only if measurements justify the extra state.

**Consequences.** The hub can recover supported revisions and reject most stale writes, but cannot close the race with an uncooperative external writer. Scans trade speed and exhaustive coverage for simple current-permission checks. If search is indexed, authorization must still apply to paths, snippets, counts, and any ranking input visible to the caller. See [filesystem consistency](../filesystem-consistency.md).
