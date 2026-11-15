---
owner: Xenobiology
status: active
depends_on: ["[[Hazard log]]", "[[Dose model]]", "[[Echo sleep physiology]]"]
tags: [keepers, echo-sleep, limits, r7]
---

# Exposure limit

The echo-sleep dose a keeper may receive. Owner: Ayo (station physician). Approved by the Disclosure Board, 28 April 2191. This note implements requirement R7 and controls hazard H-08 in the [[Hazard log]].

## The limit

| Term | Limit | Reason |
|---|---|---|
| Per exposure | **3 EH** | Above 3 EH, a third of volunteers stayed disoriented for over 40 min, too long to run a pulsar fix |
| Per 30 days | **9 EH** | Dose decays with a ~4-day half-life; repeated exposures stack |
| Per year | 40 EH | Provisional; no long-term data exist |

A keeper who reaches 9 EH in any rolling 30 days shall not sleep in the dish bay during a live listen again until their accumulated dose, decayed, falls below 6 EH.

## Why the 30-day term is 9

The mission (R1) is one live listen and one return listen. At 2.1 EH per exposure in a shielded bunk ([[Dose model]]), that is 4.2 EH. But the limit must survive things going wrong.

The case that sizes it comes from the timing chain. If the lead-time estimate is off by more than the pulsar-fix capture window, hazard **H-07**, the relay must make a corrective listen to recover. [[Lead-time error]] puts that likelihood at "remote but credible" for each listen. The limit therefore covers one corrective listen in each direction:

> 2 planned listens + 2 corrective listens = 4 × 2.1 EH = 8.4 EH ≤ 9 EH.

If H-07 becomes more likely than remote, this limit is too low for the mission, not too high. The chain runs: clock drift → lead-time error → corrective listen → dose. A nanosecond in the relay clock becomes, three notes later, a keeper's sleep.

## Application

1. Every keeper shall wear a dose badge from first exposure.
2. The station physician shall hold a running dose record for every keeper and shall have authority to remove any keeper from the live-listen roster.
3. No keeper shall be asked to sleep in an open sleeping place in the dish bay, except in emergency. An open place raises dose by 1.4 (see [[Bunk shielding requirements]]).
4. Keepers screened as sensitive (above the 90th percentile, see [[Keeper screening]]) shall not sleep in the dish bay during the first live listen.

## Margins

| Case | Dose | Margin to 3 EH |
|---|---|---|
| Median, shielded bunk | 2.1 | 0.9 |
| 90th percentile, shielded bunk | 2.7 | 0.3 |
| Median, open sleeping place | 2.9 | 0.1 |

The open-place case is legal and I would not allow it.

## Status

The limit is approved. The evidence beneath it is an extrapolation from p 0.30 to p 0.62. I signed this note because a limit with honest uncertainty is better than no limit. I shall revise it the day we have data above p 0.30, whatever those data say.
