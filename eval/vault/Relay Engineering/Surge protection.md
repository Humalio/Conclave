---
owner: Relay Engineering
status: active
depends_on: ["[[Dish array design]]", "[[CAP-009 Dish surge]]"]
tags: [surge, safety, feed]
---

# Surge protection

What happens when a feed horn stops being a superconductor while carrying 18.4 kA, or when reflected power slams back into it. Owner: Lusa. Revision 3, 2 May 2191. Safety view in [[Surge hazard]].

## The event

A surge starts at one spot: a turn moves, a joint heats, the local temperature crosses the critical line. That spot becomes resistive. Current keeps flowing because the feed's inductance insists, so the spot heats faster, and the normal zone spreads along the conductor at a few metres per second. Left alone, the hot spot passes 300 K in under two seconds and the insulation goes with it.

The design answer has three parts: detect it early, get the current out of the feed fast, and give the energy somewhere to go that is not the winding.

## Detection

| Item | Value |
|---|---|
| Sensing | voltage taps, two per layer, bridged in pairs |
| Threshold | 100 mV across any bridge |
| Validation window | 10 ms |
| Decision | hardwired logic, no software in the loop |
| Total detect time | ≤ 12 ms |

Inductive voltage during a normal ramp is balanced out by the bridge. The threshold sits five times above the worst noise seen on the prototype string.

## Response

1. Fire the crowbar on the [[Capacitor bank]] main bus.
2. Open the feed switches; current commutates into the dump resistors.
3. Fire heaters on all twelve horns, so the whole array goes normal together and the energy spreads over 37 km of conductor instead of one metre.
4. Signal abort to the [[Transmit sequence]] and the [[Shutdown criteria]] chain.

Ring time constant into the dump: 0.14 s, inside the 200 ms share of the R9 abort budget. Calculated worst hot-spot temperature at full scale: 104 K, against a limit of 120 K.

## Evidence

[[CAP-009 Dish surge]] tripped a single bench-array horn three times at 100 % scaled current in January. Detection 10 to 11 ms, dump 139 to 142 ms, peak winding temperature 71 K, no change in resistance afterwards. Bench surge margin 16.7 %, the same figure the design carries. Scaling the hot spot to the full-size winding, with its heavier copper channel and longer dump, gives the 104 K above.

The margin itself, 16.7 % at 18 K, is set in [[Dish array design]] and requires R3 ≥ 15 %. Protection does not create margin; it limits the cost of losing it.

## What protection cannot do

- It cannot stop a surge from interrupting a transmission. A surge mid-burst is an abort, and the message goes out wherever the ramp left it. Timekeepers' view is in [[Lead-time error]].
- It cannot see a slow degradation. That is what the training records in [[Feed horn spec]] are for.
- It does not watch the shroud. A shroud that cracks warms slowly; the cryo plant will see it long before we do.

> [!note] Lusa
> On the bench, the taps on run 47 never crossed threshold. The feeds were fine. Whatever stopped that run, it was not a surge, and I'd like that written down somewhere people read. See [[Echo 47 (why we stopped)]].
