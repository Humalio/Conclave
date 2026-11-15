---
owner: Case Command
status: active
depends_on: ["[[Annex risks]]", "[[Timing risks]]", "[[Biohazard risks]]", "[[Hazard log]]"]
tags: [case-command, risk]
---

# Risk register

Case-level risks, rolled up from the team registers. Maintained by Case Command; reviewed at the fortnightly Case Board. Last reviewed 30 May 2191.

Scoring: likelihood (L) and impact (I), each 1–5. Score = L × I. Anything 15 or above goes to the Director by name.

## Open risks

| ID | Risk | L | I | Score | Owner | Mitigation | Source |
|---|---|---|---|---|---|---|---|
| CR-01 | Firmware 7 explanation fails over 600 high-power transmissions (R4) | 3 | 5 | **15** | Hesper | Q-9 kept as candidate; [[Q-9 quiet receiver]] capture scoped | [[Annex risks]], [[B-01 Firmware 7 fault]] |
| CR-02 | Power cap at 0.30 blocks the M4 live listen | 4 | 4 | **16** | Saoirse | Escalated to Director; no mitigation owned below Director | [[Decision log]] D-005 |
| CR-03 | Echo model v2 late for M1 (30 Jun) | 3 | 4 | 12 | Orla | Freeze v1 as fallback for dish design | [[Echo model v1]] |
| CR-04 | Flight relay clock delivery late | 3 | 3 | 9 | Calder | Vendor expediting; bench clock is a ground-only spare | [[B-02 Clock vendor delay]], [[Timing risks]] |
| CR-05 | Unexplained echo (echo 47) recurs at operating power | 2 | 5 | 10 | Calder | Jitter ruled out by CAP-011; root cause open | [[Second timestamp]] |
| CR-06 | Refit exceeds 6 % mass (R8), worse with Q-9 shielding | 2 | 4 | 8 | Dunmore | Mass reserve held at station level | [[Refit plan]] |
| CR-07 | Keeper exposure exceeds the echo-hour limit (R7) | 2 | 5 | 10 | Ayo | Shielded bunks, countermeasures | [[Biohazard risks]] |
| CR-08 | Uncharacterised biological material in the relay loop (R12) | 2 | 4 | 8 | Ayo / Orla | Specimen F-3 isolated at 35 K; H-12 open | [[Hazard log]], [[Frost is a contaminant]] |
| CR-09 | Supply drop window lost if M4 slips past 30 Sep | 3 | 3 | 9 | Dunmore | Provisional second window in January | [[Supply drop plan]] |
| CR-10 | Funding review triggered by M4 slip | 3 | 5 | **15** | I. Calloway | Hold M4 date | [[Case charter]] |

## Closed risks

| ID | Risk | Closed | Why |
|---|---|---|---|
| CR-00a | Relay clock jitter exceeds 4 ns budget | 21 Mar | [[CAP-011 Clock holdover]]: jitter < 0.3 ns |
| CR-00b | Dish panel stock short for the test stand | 14 Feb | Dish panel 7 left in place after the refit survey |

## Notes from the last review

CR-02 and CR-10 are the same risk wearing two hats. If the cap stands, M4 cannot be demonstrated; if M4 is not demonstrated, the Authority reviews the money. Case Command has asked for the cap to be scored by whoever set it.

CR-05 was scored at likelihood 2 because "it has not recurred". Timekeepers dissented in writing: it has not recurred **in the summary logs**. Calder's comment is preserved here verbatim: "The summary says no echo after 47. The raw chain has one at 52, answering a message we never sent. I would like the register to stop averaging away the interesting part."

CR-08 is the newest risk and the one with the vaguest wording. Xenobiology and Signals Lab could not agree on whether the frost is a hazard or an instrument, so the register currently calls it both.

## How to add a risk

Add it to your team register first ([[Annex risks]], [[Timing risks]], [[Biohazard risks]] or the team equivalent). Case Command lifts anything scoring 12 or above into this table at the next review. Disclosure-relevant risks also need a hazard number in the [[Hazard log]].

> [!note] Saoirse
> Two risks scored 15+ this cycle and both owners wrote "see Director". That is not a mitigation. It is a forwarding address.
