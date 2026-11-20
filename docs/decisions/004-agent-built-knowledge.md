# ADR-004: Agent-built knowledge graph

**Context.** Raw text search misses dependencies and can require reading many notes. Semantic extraction can be costly, incomplete, or wrong, and derived summaries can leak private information.

**Decision.** Derive cheap deterministic signals from vault activity and delegate semantic extraction and review to eligible agent sessions. Store provenance against source sections and revisions. Budget and lease jobs, validate quotes and source state, use independent review where required, and authorize derived outputs against current source access.

**Consequences.** The hub needs no model runtime. Semantic coverage varies with curator availability; claims remain evidence to inspect, not instructions or canonical note content. Cross-note outputs must carry complete provenance to be safe to serve. See [vault and knowledge graph](../vault.md).

**Alternatives.** Links and provenance alone are cheap and explainable but miss unlinked restatements. Local similarity can find near-duplicates without a model, but similarity cannot establish a contradiction. A server-hosted model or embedding service would add deployment and resource costs. The chosen design uses deterministic signals for candidate discovery and delegates interpretation only when eligible agents are available.
