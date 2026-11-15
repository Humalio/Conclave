---
owner: Disclosure Board
status: active
depends_on: ["[[Shutdown criteria]]", "[[Surge protection]]", "[[Transmit sequence]]"]
tags: [safety, shutdown]
---

# Emergency silence

What the dish shall do when a shutdown is commanded, and what the keepers shall do while it happens. Owner of the procedure: Relay Engineering. Reviewed by the Disclosure Board, 28 April.

## Definition

1.1 An emergency silence is a commanded, symmetric drop of transmit power from any state (charging, holding, transmitting) to zero, executed by the hard-wired shutdown chain rather than by ORRIN or the relay clock.

1.2 It is not a surge dump. A surge dump is triggered by a feed module; an emergency silence is triggered by the shutdown chain. Both fire the same dump resistors, so both silence the dish symmetrically.

## Sequence

| Step | Time after shutdown | Action |
|---|---|---|
| 1 | 0 ms | Shutdown asserted (keeper switch, controller, or any trip in [[Shutdown criteria]]). |
| 2 | ≤ 2 ms | Charge contactors open; the bank is isolated per [[Transmit sequence]]. |
| 3 | ≤ 10 ms | Dump resistors fire on all feed modules. |
| 4 | ≤ 180 ms | Feed current below 5 % of nominal. Transmit power below 0.01. |
| 5 | ≤ 200 ms | Shutdown complete (R9). Receiver cryo valves to hold. |
| 6 | 200 ms – 90 s | Bank bled to safe; status to the keepers' console. |

## Requirements

2.1 The shutdown chain shall be independent of the relay clock, the feed controller software, ORRIN and the station network.

2.2 The silence shall complete within 200 ms from any state (R9).

2.3 An emergency silence during a transmission leaves the relay clock without a trusted phase. Keepers shall remain in their shielded bunks until a pulsar fix is complete; see [[Pulsar-fix procedure]].

2.4 After any emergency silence, the dish and receiver cold face shall be inspected before the next charge.

## Verification

3.1 Shutdown chain timing on the subscale dish: 142 ms mean, 171 ms worst, 40 trials.

3.2 No shutdown fired on echo 47. The dish exceeded its planned power for 3.0 s, no trip existed for power over plan (T-3 was added the next day), and the silence was commanded on schedule at 22:14:07.000. The Board has questioned whether a transmission that went 0.09 past plan without asserting the shutdown chain counts as evidence for this procedure or against it.
