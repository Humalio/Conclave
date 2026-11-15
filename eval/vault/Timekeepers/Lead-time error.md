---
owner: Timekeepers
status: active
depends_on: ["[[Clock drift model]]", "[[Echo decay]]"]
tags: [timing, lead-time, h-07]
---

# Lead-time error

How well Tern-9 knows when a reply landed, compared with when it did. Requirement R6: **≤ 5 ns**. Owner: Calder. Feeds hazard H-07 in the [[Hazard log]], "lead-time error beyond the pulsar-fix capture window".

## Why timing becomes position

Tern-9 learns where it is, and when it is, from the same clock. A stamp error is a range error: the station places itself wrongly along the line of sight, and every reply is then dated against the wrong origin. For the long-haul beam at P 0.62 the sensitivity is:

> **1 ns of stamp timing error ≈ 1 ns of lead-time error ≈ 0.30 m of range error**

Calder has asked that this number be printed on a card and taped to the clock rack.

## Error budget

| Contribution | Value | Source |
|---|---|---|
| Stamp timing, at the 4 ns limit | 4.0 ns | [[Relay clock design]], [[Clock drift model]] |
| Residual ring after the fast stage | 0.75 ns | [[Echo decay]], extrapolated to P 0.62 |
| Station position knowledge at send | 0.125 ns | Pulsar fix before the transmission |
| **Total (linear)** | **4.875 ns** | R6 limit 5 ns |

Margin: 0.125 ns, or about 3.7 cm of path. In timing terms that is a comfortable afternoon. In budget terms it is a rounding error with ambitions.

With the expected (not limiting) clock performance of about 1.9 ns, the timing share falls to 1.9 ns and the total to 2.8 ns.

## Capture window and H-07

After a transmission the keepers run the [[Pulsar-fix procedure]]. The procedure converges if the true lead is within the **capture window of 12.5 ns** of the predicted lead. Outside that, it may still converge, but slowly and with a risk of locking onto the wrong reference set.

| Lead-time error | Consequence |
|---|---|
| ≤ 5 ns | Nominal. Pulsar fix in about 40 minutes. |
| 5 – 12.5 ns | R6 violated; pulsar fix still captures. Longer search. |
| > 12.5 ns | **H-07.** Pulsar fix may not capture. Extended search; next send delayed; keepers' echo-hour budget ([[Exposure limit]]) starts to bind. |

To reach H-07 from timing alone needs a stamp error of about 12 ns, three times the budget. To reach it from a 0.71 s error needs nothing at all, because a 0.71 s error is not on this table. It is off the end of every table Timekeepers own.

## Sensitivity to power

The residual-ring term scales roughly with held power. At calibration powers it is tiny, which is why calibration timing anomalies have never had a position consequence. Above P 0.32 nobody has measured the scaling, for reasons recorded in the [[Decision log]].

## Open items

- Confirm the residual-ring term once Echo model v2 replaces [[Echo model v1]].
- Re-run the budget with the replacement clock once it arrives ([[B-02 Clock vendor delay]]).
- Decide what a reply stamped 0.71 s early would mean for lead-time error if it happened at P 0.62. Timekeepers have drafted the question three times. See [[Second timestamp]].

> [!note] Calder
> Our margin against R6 is 3.7 centimetres. Our margin against whatever happened on echo 47 is undefined. I would prefer to be worried about the first one.
