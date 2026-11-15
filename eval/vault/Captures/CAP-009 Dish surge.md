---
owner: Relay Engineering
status: closed
depends_on: ["[[Feed horn spec]]", "[[Dish test plan]]"]
tags: [dish, surge, r3]
---
# CAP-009 Dish surge

Capture lead: Dario. Console: Kemi. Tern-9 dish test stand, receiver bay 2, 13–24 January 2191. Closed 27 January.

## Purpose

Measure the surge margin of a single bench feed module built to [[Feed horn spec]], and prove that the detection-and-dump chain in [[Surge protection]] catches a surge before the line sees damage. Requirement R3: surge margin ≥ 15 %.

## Method

One module from the 1:20 subscale dish, mounted alone on the cold fixture at 40 K. Current ramped in steps of 2 % of the scaled nominal (18.4 kA at p 0.62, scaled to the bench) and held 60 s at each step. Margin is measured by raising the module temperature in 0.1 K steps at fixed current until a normal zone appears. Three deliberate surges were induced with the spot heater at 100 % current to time the protection chain. Module temperatures logged at 10 Hz, see [[dish-thermal.csv]].

## Log

```
13 Jan 10:05  cooldown complete. 40.0 K.
14 Jan        ramp to 100 % scaled. no events.
15 Jan        ramp to 110 %. no events.
16 Jan 14:22  temp margin @100 %: normal zone at 47.0 K.
17 Jan 11:40  induced surge #1. detect 11 ms. dump 142 ms. peak 71 K.
20 Jan 09:55  induced surge #2. detect 10 ms. dump 139 ms. peak 69 K.
21 Jan 16:10  induced surge #3. detect 11 ms. dump 141 ms. peak 70 K.
24 Jan        warm-up. visual: no damage. resistance within 0.2 % of pre-test.
```

## Result

| Quantity | Measured | Requirement | Status |
|---|---|---|---|
| Surge margin (current) | 16.7 % | ≥ 15 % (R3) | Pass |
| Temperature margin at 100 % | 7.0 K | — | Recorded |
| Detection time | 10–11 ms | ≤ 12 ms | Pass |
| Dump time constant τ (energy dump) | 139–142 ms, τ ≈ 0.14 s | ≤ 200 ms (R9 budget share) | Pass |
| Peak line temperature | 71 K | ≤ 120 K | Pass |

The module survived three induced surges with no measurable change in resistance. The margin carries into [[Dish array design]] as the bench figure, to be confirmed at full scale before M4.

## Limits

- One module, not an array. Coupling between neighbours in the twelve-module array is not tested here; that belongs to the live-listen series, [[CAP-016 Live listen]].
- No transmit power: a single module does not make a signal, so nothing about power or the shield can be read from this capture.
- Cold fixture at the time was the old one, before the 26 February rebuild.

## Notes

> [!note] Kemi, 27 January
> Cleanest capture we have run on this stand. Three surges, three identical curves, nothing in any channel we didn't put there. File it as the baseline. If anything on this stand ever looks strange, compare it to this first.
