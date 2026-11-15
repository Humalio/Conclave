---
owner: Tern-9 Keepers
status: active
depends_on: ["[[Power budget]]", "[[Refit plan]]"]
tags: [cables, power, install]
---

# Cable routing

Where the new power, cryo and signal runs go, and how we keep them from setting the station on fire. Owner: Fen. Revision 2, 27 May 2191.

## What has to be connected

![[power-flow.svg]]

| Run | From | To | Rating | Length |
|---|---|---|---|---|
| R1 bank bus | Capacitor bank, station 52 | Converters, station 49 | 4.2 kV, 8 strings | 2 × 9 m |
| R2 feed bus | Converters, station 49 | Feed ring, stations 41–47 | 18.4 kA, cryogenic bus in its own cryostat | 2 × 14 m |
| R3 dump | Ring switches | Dump resistors, station 48 | 18.4 kA for 40 ms | 2 × 6 m |
| R4 plant feed | Reactor switchboard | Bank chargers | 3.4 MW, 690 V | 31 m |
| R5 surge taps | 12 horns | Surge logic rack, station 50 | signal, 48 bridges | 12 × 22 m |
| R6 timing | Relay clock, station 36 | Ring switches | fibre, matched length | 3 × 18 m |
| R7 cryo lines | Cryo plant, station 53 | Feeds and shroud | helium and neon, vacuum-jacketed | ~140 m |

The numbers come from [[Power budget]] and the [[Capacitor bank]] note. If they change, the copper changes, and so does the mass.

## Rules

1. **Separation.** Transmit power (R1–R3) stays at least 600 mm and one bulkhead from living-volume circuits. That's what keeps a bus fault out of the bunks; see [[Bunk shielding spec]].
2. **No splices in R2 or R3.** One piece each, pulled from reel to termination. If one gets damaged, we pull a new one.
3. **Fire.** H-11 in the [[Hazard log]] is fire in cable runs. All new trays are steel, all cable is low-smoke, every tray penetration gets a fire collar. The old 2171 trays near station 41 are aluminium and are coming out.
4. **Matched timing fibre.** R6 runs are cut to the same length within 2 mm, because Timekeepers said 4 ns and 2 mm of fibre is about 10 picoseconds and they still asked.
5. **Labelling.** Every cable labelled every 3 m and at every penetration. If I find an unlabelled cable in my station I'll pull it myself.

## Trays

- Port and starboard main trays along the tower, between stations 41 and 52, mounted on the frame doublers after those are installed ([[Dish mount installation]]).
- Clearance from doubler rivet heads: 25 mm minimum. Frames 41 and 47 are tight; trays drop 40 mm there.
- Cryo lines run in their own trays, inboard, never above a power run. If a cryo line leaks, cold helium does not get to drip on 4.2 kV.

## The cable nobody can trace

During strip-out on 19 March we found a 6 mm² cable running from station 44 forward along the starboard side, through two bulkheads, and terminating in a blanked connector at station 31. Not on any drawing. Not on the 2189 refit list. It's coming out with the old trays; logged in the [[Station log]] so the next person doesn't spend a day on it like Fen did.

## Mass

Cables and trays: 22.6 t, inside the [[Refit plan]] budget. R2 alone is 3.8 t because the cryostat is heavy, not the conductor.

> [!note] Fen
> R7 is "about 140 m" because the cryo plant is still moving around on Dario's drawings. When it stops moving, I'll give you a number to the centimetre.
