---
owner: Case Command
status: active
depends_on: ["[[Case charter]]"]
tags: [case-command, requirements]
---

# Requirements

Top-level requirements for the Echo Case, R1–R12. Case Command owns this page; teams may cite "R4" and so on anywhere in the vault. Each requirement is verified against a named capture or analysis, never against an opinion (R11).

## Requirement table

| ID | Requirement | Owner | Verification | Evidence so far |
|---|---|---|---|---|
| **R1** | The case shall send one controlled reply to the echo and log what answers it. | Case Command | Capture (M7) | None yet; scheduled |
| **R2** | The echo model shall be frozen and validated before dish design review. | Signals Lab | Tern-9 comparison | [[Echo model v1]] validated to power 0.30 only |
| **R3** | Dish surge margin shall be ≥ 15 %. | Relay Engineering | Capture | [[CAP-009 Dish surge]], [[Surge protection]] |
| **R4** | The explanation shall hold over 600 transmissions at operating power. | The Annex | Capture | [[CAP-014 Air-gapped capture]], running, result pending |
| **R5** | Relay clocks shall stamp every send and receive within 4 ns. | Timekeepers | Capture and analysis | [[CAP-011 Clock holdover]], [[Clock drift model]] |
| **R6** | Lead-time error shall be ≤ 5 ns. | Timekeepers | Analysis | [[Lead-time error]] |
| **R7** | Keeper exposure shall stay within the echo-hour limit. | Xenobiology | Analysis and capture | [[Exposure limit]], [[Dose model]] |
| **R8** | The refit shall add ≤ 6 % to station mass. | Tern-9 Keepers | Weighing, as-built | [[Refit plan]] |
| **R9** | A relay shall go silent within 200 ms of a shutdown command. | Relay Engineering | Capture | [[Shutdown criteria]], [[Emergency silence]] |
| **R10** | Every disclosure-critical item shall have an independent review. | Disclosure Board | Review record | [[Independent review rules]] |
| **R11** | Every result used in the disclosure case shall be traceable to a capture ID. | Case Command | Audit | This vault |
| **R12** | No uncharacterised biological material shall be in the relay loop. | Xenobiology | Inspection | Added 23 Apr; see below |

## Rationale notes

**R2.** "Validated" means the model predicts Tern-9 behaviour within stated tolerance over the whole range the Net uses. Full relay service runs to power 0.62. No validation transmission has been allowed above 0.30 since 4 March. Signals Lab proposes validating to 0.30 and extrapolating; Timekeepers and Case Command have both noted that extrapolation is what validation is meant to replace.

**R4.** "Operating power" was left undefined in revision C. Case Command's working reading is "the highest power a relay sees in service". CAP-014 approximates that by sending 600 transmissions at 0.33, after a 200-transmission control block. The Annex has asked for the figure to be fixed in writing.

**R5.** A timing error becomes a lead-time error. 4 ns is set by R6, not the other way round; see [[Lead-time error]].

**R9.** Silence shall complete within 200 ms. A commanded stop drops the carrier in about 40 ms; the slowest path, a surge dump through the resistors (τ ≈ 0.14 s), still has to bring the dish below the dish-house leak limit inside 200 ms.

**R11.** Results with no capture ID cannot be used. This has already bitten once: echo 52 exists only in a raw clock file, with no transmission record of its own. See [[Second timestamp]].

## R12

R12 was added on 23 April alongside hazard H-12, "unidentified biological material", in the [[Hazard log]]. Its rationale field reads, in full: "See H-12." Its verification method is "inspection", which presumes somebody knows what to inspect for.

The requirement follows the discovery of the frost on Tern-9's dish face ([[IR-0412 Tern-9 cryo alarm]]). The requirement does not mention the frost by name, and the charter revision that would add it to the case's purpose is unsigned.

## Traceability

Each requirement maps to at least one milestone:

| Milestone | Requirements closed |
|---|---|
| M1 | R2 |
| M2 | R3, R9 (design) |
| M3 | R4 |
| M4 | R3, R5, R9 (capture) |
| M5 | R8, R12 (inspection) |
| M6 | R7, R10, R11 |
| M7 | R1, R6 |

> [!note] Saoirse
> R12 is the only requirement written after something happened rather than before. Somebody should say out loud what happened. The [[Case board]] is as close as anyone has come.
