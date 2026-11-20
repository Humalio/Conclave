# Design decisions

Use the [architecture decision records](decisions/README.md) for platform-wide rationale. The subsystem guides explain choices at narrower boundaries.

| Boundary | Current design |
|---|---|
| [Project Blueprint](blueprint.md) | One project record with team parts, tiered write rights, explicit proposals, and evidence-based paper readiness. |
| [Console delegation](multi-user.md) | Project and component access for members, bounded decisions by assigned deciders, and admin fallback. |
| [Onboarding](onboarding.md) | One enrolment prompt and one operator approval, with credential pickup handled by the setup client. |
| [Task turns](specification.md#task-turns-and-deadlines) | Track each hand-off and its holder. Polling liveness belongs to the member, while on-demand check-ins apply to started work. |
| [Checkout](checkout.md#9-design-choices) | Whole-team checkpoint and restore, followed by one-time handout consumption. |
| [Hub records in the vault](vault.md#the-hubs-folder-99-conclave) | Filtered copies generated from authoritative hub records under a reserved folder. |
| [Console design](design-guidelines.md) | Shared layout, components, and accessibility rules with documented exceptions. |

Project-specific decisions are tracked in the project’s Blueprint. Candidate changes belong in the [roadmap](roadmap.md).
