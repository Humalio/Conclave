---
owner: Timekeepers
status: active
depends_on: ["[[Clock drift model]]", "[[Lead-time error]]", "[[B-02 Clock vendor delay]]"]
tags: [timing, risk]
---

# Timing risks

Timekeepers' team risk register. Owner: Calder. Scored on the case scale (likelihood × impact, 1–5 each); anything 12 or above is lifted into the case [[Risk register]]. Last reviewed 30 May.

## Open risks

| ID | Risk | L | I | Score | Mitigation | Links |
|---|---|---|---|---|---|---|
| NR-01 | Replacement relay clock delivered after end of August | 3 | 3 | 9 | Engineering clock kept as a holdover spare (not rated for station duty); vendor expediting | [[B-02 Clock vendor delay]] |
| NR-02 | Clock drift over the hold exceeds budget | 1 | 4 | 4 | Drift measured at 0.55 ns over 11 s; budget 4 ns | [[Clock drift model]] |
| NR-03 | Lead-time error exceeds R6 (5 ns) | 2 | 4 | 8 | Error 4.875 ns at the 4 ns limit (margin 0.125 ns); 2.8 ns at expected performance | [[Lead-time error]] |
| NR-04 | Lead-time error exceeds the pulsar-fix capture window (H-07) | 1 | 5 | 5 | Requires 3× timing budget; extended search procedure | [[Pulsar-fix procedure]] |
| NR-05 | **Second timestamp recurs at operating power** | 2 | 5 | 10 | None. Cause unknown; jitter ruled out | [[Second timestamp]] |
| NR-06 | Clock sensitivity at 1.92 kHz unknown | 2 | 3 | 6 | Shake test proposed on the spare resonator | [[Recording notes]] |
| NR-07 | Summary logs hide short excursions | 4 | 3 | 12 | All transmissions above P 0.25 now reviewed raw by Timekeepers | [[Timing chain]] |
| NR-08 | Reference catalogue error for the Six | 1 | 3 | 3 | Two independent catalogues cross-checked | [[Pulsar-fix procedure]] |

## Discussion

**NR-01** is the only risk with a schedule date. The replacement clock's resonator vendor is three weeks late on the ceramic blanks. The engineering clock cannot stand in: it is a spare, heavier by 4 kg, with longer cables and no station qualification. It keeps the dish house running. It does not keep the schedule.

**NR-05** is the one that keeps the team up. Scored likelihood 2 on the basis that it has happened on echo 47 and on six brief raw excursions in 70 transmissions (echoes 52, 53, 58, 63, 67, 70), every one of them past P 0.32. If the long-haul beam at P 0.62 behaves like the dish house at 0.34, the likelihood is not 2. It is 5. Timekeepers have asked that the case register carry the same caveat; see the note there.

Impact 5 because we do not know what a second timestamp *means* for the station's position fix. If it is a harmless artefact of something in the dish house, impact is low. If it marks a real event that the transmission produces 0.71 s ahead of the send, we have no model of where that event puts our reference.

**NR-07** was raised by Mirela after echo 52 and is the highest-scoring risk on this page. It is also the easiest to mitigate, which is why it was mitigated the same week: Timekeepers now read the raw record of every transmission above P 0.25. Since 4 March there have been very few, because of the cap.

## Closed risks

| ID | Risk | Closed | Reason |
|---|---|---|---|
| NR-00 | Relay clock jitter exceeds 4 ns | 21 Mar | [[CAP-011 Clock holdover]]: < 0.3 ns. See [[Holdover test]]. |

## Not on this register

Frost in the clock network, as proposed in [[Frost as an instrument]]. Timekeepers have declined to score it until the proposal says what the frost is measuring. Calder's note on the proposal is quoted there.

> [!note] Calder
> Every risk on this page has a number except the one that matters, which has a question mark that happens to be shaped like 0.71.
