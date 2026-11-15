---
owner: Timekeepers
status: active
depends_on: ["[[Lead-time error]]"]
tags: [timing, pulsar-fix, procedure]
---

# Pulsar-fix procedure

How the keepers find out where Tern-9 is, and when, after a transmission. Owner: Tobin. Reviewed by Calder. This procedure is the reason the [[Lead-time error]] budget has a capture window in it.

## Purpose

After a send the station's position and clock are known only to about the lead-time error, nominally ≤ 5 ns (R6). The pulsar-fix procedure measures the arrival phases of known reference pulsars, compares them with the catalogue as seen from the predicted position, and solves for the true position and time. The problem is not precision, it is identification: which pulse is which.

## Capture window

The solver needs a starting guess within **12.5 ns** of the true lead to match observed pulses to catalogue pulses unambiguously. Inside that window it converges in one pass. Outside it, it can match the wrong cycle and converge confidently on the wrong answer. That failure is hazard H-07 in the [[Hazard log]].

## Procedure

1. **T+0.** Transmission ends. Dish to cold sky on the keeper's call, once the signal-leak indicator reads safe ([[Signal leak hazard]]).
2. **T+2 min.** Wide survey takes the reference frame: the 40 strongest millisecond pulsars in a 30° cone ahead and astern.
3. **T+5 min.** Narrow survey takes six designated reference pulsars, chosen in advance for distinct period and profile. The Authority's catalogue lists them by number; the keepers already call them the Six.
4. **T+8 min.** Solver run 1 from the predicted position. Accept if all six match with phase residual < 0.1 µs.
5. **T+15 min.** Solver run 2 with the wide survey as an independent check.
6. **T+40 min.** Keeper signs the fix. Net master time is re-disciplined; the relay clock leaves holdover.
7. If runs 1 and 2 disagree by more than 1.25 ns, or if fewer than five of the Six are matched: go to the extended search (below).

## Extended search

Grid the uncertainty region at 3 ns spacing and re-run the solver from each grid point. Accept the solution that matches all six reference pulsars from the most grid points. At 12.5 ns uncertainty this takes about 4 hours. At 50 ns it takes most of a day, and the keepers' echo-hour count keeps running in the background ([[Exposure limit]]).

## Practice

Tobin has run the procedure 112 times in simulation with errors drawn from the budget. Median fix time 37 minutes. Worst case inside budget 52 minutes. Seeded outside the capture window at 20 ns: 9 of 20 runs converged on the wrong answer before step 5 caught them. Step 5 is why step 5 exists.

## What the procedure assumes

- The station sends once, at one time.
- The relay clock knows when the send happened, to within its budget.
- The catalogue is right.

The first assumption has never been questioned. The second has been questioned exactly once, by the clock itself, on echo 47 ([[Second timestamp]]). Tobin asks that someone tell him which stamp the procedure should treat as the real one if the clock ever logs a reply before the send.

## Related

- [[Relay clock design]] for the clock that leaves holdover at step 6.
- [[Timing risks]] for the procedure's risk entries.

> [!note] Tobin
> The Six are pretty. I chose them for profile so a tired keeper can find them by eye on the scope. If we ever need to find them by eye, something has already gone wrong upstream of me.
