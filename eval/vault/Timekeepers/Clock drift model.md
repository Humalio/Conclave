---
owner: Timekeepers
status: active
depends_on: ["[[Relay clock design]]", "[[Holdover test]]"]
tags: [timing, drift]
---

# Clock drift model

How far the relay clock wanders from true time while it is cut off from its reference during a transmission. Owner: Mirela. This is the first link in the timing chain of consequences: drift feeds [[Lead-time error]], which feeds hazard H-07 in the [[Hazard log]], which feeds the keepers' [[Exposure limit]] (a long pulsar-fix search means more hours on the dish and more echo-hours in the bunk).

## Model

During a send the clock runs in holdover. Its error grows from four sources:

| Term | Form | Value (engineering clock) |
|---|---|---|
| Initial offset | constant | ≤ 0.20 ns after pulsar-fix sync |
| Frequency offset | linear in t | 0.050 ns/s |
| Aging | quadratic in t | 2 × 10⁻⁶ ns/s², negligible over a send |
| Drive-ramp sensitivity | step during the 90 s PA warm-up | 0.03 ns per kW of PA load, absorbed into initial offset |

Total drift over a hold of duration t:

> e(t) ≈ 0.20 + 0.050 · t   (ns)

For the long-haul beam, an 11 s hold at P 0.62, drift alone is 0.55 ns; with initial offset 0.75 ns. Both figures sit comfortably inside the 4 ns budget in [[Relay clock design]].

## Data

The model is fitted to [[clock-drift.csv]], the 72-hour holdover record from [[CAP-011 Clock holdover]]. Timekeepers' analysis of the same record is in [[Holdover test]].

| Fit | Value | 95 % range |
|---|---|---|
| Frequency offset | 0.050 ns/s | 0.046 – 0.054 |
| Aging | 2.1 × 10⁻⁶ ns/s² | 1.4 – 2.8 × 10⁻⁶ |
| Residual (white) | 0.27 ns RMS | — |

The white residual is what most people mean by jitter. It is below 0.3 ns.

## What drift can and cannot do

Drift is slow and smooth. Over 11 s it moves the clock by about half a nanosecond. To move the clock by 0.71 s, the engineering clock would have to run in holdover for roughly 1.4 × 10¹⁰ seconds, which is about 450 years, or alternatively be broken in a way that both oscillators agree on.

CL-A and CL-B are cross-compared every 10 µs. On echo 47 they agreed with each other to within 0.1 ns throughout, including across 22:14:06.290. Whatever put an event there did not put it there by drifting.

## Sensitivities

- **Temperature of the 4 K can.** 0.008 ns/s per mK. The cryo plant holds the can within ±2 mK.
- **Vibration.** The PA warm-up shakes the dish house at 40–120 Hz; the resonators are insensitive in that band. Nobody has measured sensitivity at 1.92 kHz, because until March nobody had a reason to.
- **RF field.** The can is outside the petal ring and shielded. Leakage at the clock at P 0.62 is predicted to shift frequency by under 0.001 ns/s. Nobody has measured the can inside the 2.3 GHz ring band.

## Use downstream

- [[Lead-time error]] takes e(11 s) = 0.75 ns as the drift share of the timing error.
- [[Timing risks]] carries clock drift as a low risk, with the replacement clock's delivery as the real exposure.

> [!note] Mirela
> A drift model is a promise about how wrong you will be, slowly. Echo 47 was not wrong slowly. See [[Second timestamp]].
