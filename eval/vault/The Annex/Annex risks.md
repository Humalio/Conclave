---
owner: The Annex
status: active
depends_on: ["[[Timestamp fault model]]", "[[Firmware 7]]", "[[Vendor audit]]"]
tags: [risk, annex]
---

# Annex risks

Team risk list for The Annex. Rolls up to the case [[Risk register]]. Owner: Hesper. Reviewed weekly; last review 30 May 2191.

## Scoring

Likelihood and consequence each 1–5; score is the product. Anything 12 or above goes to the case register.

## Register

| ID | Risk | L | C | Score | Owner | Mitigation | Trend |
|---|---|---|---|---|---|---|---|
| AR-01 | Firmware 7 fails to explain the early replies before M3 (R4) | 3 | 5 | **15** | Hesper | [[CAP-014 Air-gapped capture]] running; [[Q-9 quiet receiver]] parked as backup | **up** |
| AR-02 | Pellam lot P7-L07 paperwork cannot be closed | 3 | 3 | 9 | Hesper | [[B-01 Firmware 7 fault]]; revised release record requested | **up** |
| AR-03 | Frame 44 margin eroded by as-built deviations | 2 | 4 | 8 | Rafi | Insert design in [[Dish mount reinforcement]]; keeper survey | down |
| AR-04 | Q-9 parts delivery slips (single instrument shop) | 3 | 3 | 9 | Vesna | Two-bench option costed; see [[Case file AT-0412]] | steady |
| AR-05 | Timestamp model misses a signal mechanism | 2 | 5 | 10 | Rafi | Broadband record before M3 (Halden action) | steady |
| AR-06 | Receiver contamination affects CAP-014 results | 2 | 3 | 6 | Rafi | Empty-dish repeat [[CAP-014b Empty dish]] in Cold bay 3 | new |
| AR-07 | Cable shield bond at 40 K below datasheet | 2 | 4 | 8 | Vesna | Bond samples in July | steady |
| AR-08 | Q-9 switch adds mass and alignment time | 1 | 3 | 3 | Vesna | Parked; reservation on screening foil to 30 Sep | steady |

Only AR-01 is at 12 or above, and it already sits on the case register as PR-01, so nothing new goes up this week.

## Notes on AR-01 and AR-05

**AR-01.** Baseline margins are large ([[CAP-012 Baseline listen]]: +38 %), the [[Timestamp fault model]] predicts first overflow at 29,000 transmissions at 0.25, and CAP-014 is clean at 480. On paper this should be a 1. We score it 3, matching PR-01, because CAP-014b, the empty-dish repeat, still logged an early reply on its 450th transmission, because the second half of CAP-014 runs above 0.32 for the first time, and because the model has only ever been checked in its own band.

**AR-05.** Raised by Halden on 14 May. The model sees 40–400 MHz. There is at least one recorded line outside that band (see the footnote in the Timestamp fault model). One line on one run is not a mechanism. It is also not nothing.

## Review history

- 15 Apr: AR-06 added after the cryo alarm ([[IR-0412 Tern-9 cryo alarm]]). Xenobiology thinks the film on R-3 may have pitted the receivers. We don't, but the empty-dish repeat (started 6 May) will tell.
- 28 May: AR-01 likelihood 2 → 3, matching PR-01. AR-02 likelihood 2 → 3.
- 30 May: no changes.

> [!note] Halden, 30 May
> AR-01 and AR-05 are the same risk written twice. If the model is missing a signal, the explanation fails early. I'd merge them and score it honestly. Hesper prefers to keep "the firmware" and "our understanding of the firmware" separate. I see the point. I don't share it.
