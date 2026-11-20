# ADR-006: Blueprint rules the operator turns on

**Context.** In the Blueprint, every change a coordinator may not make itself becomes a proposal for the operator ([blueprint](../blueprint.md) §4). After each deploy, a team's release notes waited for the operator too: creating a `release` item and writing its text are "dates, scope and text", which need the operator, while the release's status is already the coordinator's. That made the operator the bottleneck for a record that only reports what was shipped. The operator said yes on 18 Nov 2026 to one rule, release notes, and no other.

**Decision.** The operator may let a team apply named kinds of Blueprint change without a proposal. The kinds are a fixed list in the hub (`BP_RULES` in [kinds.ts](../../server/src/blueprint/kinds.ts)), never free-form, and the list holds one rule:

- **Release notes** (`release_notes`): creating a `release` item in the team's own part, and writing its title, body, `notes` and, when it is created, its `version`. Its status was already the coordinator's.

The operator turns a rule on per project and team, pauses it, or turns it off, in the team's settings. A change takes effect on the next write. A write that also changes anything outside the rule (a date, a `ships` link, another item's text) becomes one proposal, the whole write, as before. Each write a rule applies names the rule in its history (the event and each item's revision), is audited, and shows once a day under **For awareness** on Home: "n changes applied by rules", which opens the list.

Nothing touching keys, rights, goals, the spec or deletions can be a rule. A rule gives the agent no operator authority: what it writes stays the agent's writing, L1 to its own team and L2 to other teams, and never L0. "Applied by a rule" does not mean "approved by the operator".

Superseding is not a rule. When the operator accepts a decision that `supersedes` another, the hub moves the old decision to `superseded` in the same write: it is the operator's one act, with nothing to switch on.

**Consequences.** "The operator's acts are always a proposal" now has one named, audited exception that the operator controls per team. The rules text agents read (`bp_read {rules: true}`) and §4 say so. Adding a rule later is a decision of its own, recorded here.

**Alternatives not taken.** A wider first list (acceptance criteria under an agreed requirement, glossary terms, superseding as a rule), which the specification review advised against until the operator asks; free-form rules, which would let the list grow without a decision; and making the coordinator's writes on releases apply always, which would remove the operator's switch.
