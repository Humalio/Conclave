---
owner: Relay Engineering
status: paused
depends_on: ["[[Dish array design]]", "[[Surge protection]]"]
tags: [test, dish, bench]
---

# Dish test plan

The dish qualification campaign, from practice feeds to the ground live listen. Owner: Brannoc. Revision 7, 22 April 2191. **High-power runs paused since 4 March.**

## Campaign structure

| Phase | Article | Where | Purpose | State |
|---|---|---|---|---|
| P1 | Practice feeds P-1 to P-4 | feed shop, test dewar | winding quality, training, surge | done |
| P2 | Bench array (1:20 ring of 12) | Test Stand 2, Cold bay 2 | beam shape, sequence, switch timing | **paused above power 0.30** |
| P3 | Subscale listens L-01 to L-05 | Cold bay 2 | transmit and listen at rising power | L-05 paused |
| P4 | Full-scale feed pair | Test Stand 1 | force, surge at scale | not started |
| P5 | Ground live listen | Test Stand 2 | M4 | see [[CAP-016 Live listen]] |

Runs are numbered globally across P2 and P3. Every run is in the [[Listening log]].

## Listen ladder

| Listen | Run | Date | Planned power | Reached power | Result |
|---|---|---|---|---|---|
| L-01 | 31 | 4 Feb | 0.20 | 0.20 | clean |
| L-02 | 39 | 18 Feb | 0.23 | 0.23 | clean |
| L-03 | **47** | **3 Mar** | 0.25 | **0.34** for 3.0 s | stopped; see [[Echo 47 (why we stopped)]] |
| L-04 | 55 | 16 Apr | 0.28 | 0.28 | clean, under the cap |
| L-05 | none | none | 0.30 | none | **paused** |

The ladder was meant to climb in small steps, a few hundredths at a time, so that each run tested a little more than the last. L-03 took a step of 0.09 on its own. Nothing in the feed, the amplifier or [[Surge protection]] accounts for that: drive was at setpoint, taps balanced, switches opened on command.

After 4 March every run is capped at power 0.30 and L-05 is paused until the programme lifts the cap. L-04 was re-planned under the cap.

## Instrumentation per run

- Feed currents, all 12, at 5 kHz.
- Voltage taps, 48 bridges.
- Receiver strain, 6 gauges on the cold fixture, 5 kHz since 1 March (2 kHz before).
- Temperatures: feeds, receivers, fixture.
- Relay clock: commanded and logged send times.
- Bay microphone (added in February for switch acoustics).

Recordings for L-03 are kept whole as [[live-listen-03.bin]] with a sidecar [[live-listen-03.json]]. Channel notes are in [[Recording notes]].

## Exit criteria for P3

1. Five listens with reached power within ±0.02 of planned.
2. Switch jitter ≤ 1 ns.
3. No unexplained events.

Criterion 3 is not met. It is the only one not met.

## What happens next

The campaign restarts when either Signals Lab explains L-03 or the programme accepts it as explained. Until then the bench runs [[CAP-014 Air-gapped capture]]: under the cap to run 500, then at power 0.33 by the director's exception, which nobody on this team asked for and nobody on this team was told the reason for.

> [!note] Brannoc, 5 March
> I signed the pause. I did not write the reason for it. If you are looking for that, it is not in this folder.
