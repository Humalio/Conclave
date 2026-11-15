---
owner: Relay Engineering
status: active
depends_on: ["[[Dish array design]]"]
tags: [cryo, thermal]
---

# Cryo plant

Keeps the feed horns and receivers at 18 K and the receiver shroud at 40 K, on the station and on the test stand. Owner: Dario. Revision 2, 18 May 2191.

## Two temperatures, two loops

| Loop | Serves | Setpoint | Heat load (steady) | Cooler |
|---|---|---|---|---|
| Loop A | 12 feed horns and receivers | 18 K | 310 W at 18 K | 4 × helium cryocoolers, 1 spare |
| Loop B | receiver shroud | 40 K | 2.2 kW at 40 K | 2 × neon-cycle coolers |

The margin in [[Dish array design]] (16.7 %) holds at 18 K and is gone by 20 K. That makes Loop A the most important two degrees on the station. Loop A has a spare cooler for that reason, and an alarm at 18.6 K.

Loop B is the big one by heat. The shroud has about 250 m² of surface facing warm structure, and even good multilayer insulation leaks.

## Measured heat loads

Bench data from Cold bay 2 and the prototype feed string are in [[dish-thermal.csv]]. What matters in it:

- Feed temperature follows the ramp: about 0.3 K rise at full drive on the practice feeds, recovered in 4 minutes.
- Shroud temperature sits within 0.4 K of setpoint during runs.
- Cryo power steps up during a ramp by about 9 % and settles.

One entry in the plant's own event log is worth a look: on 9 April at 03:40, the Cold bay 2 shroud loop jumps 1.1 K for under a second during a pressure transient, then recovers. The only thing running was run 53, an automated thermal soak at power 0.24, well inside the cap. That is the [[IR-0412 Tern-9 cryo alarm]] night. Our plant did nothing wrong; the logs show the coolers responding to the transient, not causing it.

## Cool-down

| From 293 K to setpoint | Feeds | Shroud |
|---|---|---|
| Station, full array | 6.5 days | 9 days |
| Bench, Cold bay 2 | 18 h | 30 h |

Nine days for the station shroud is long. A heavier shroud (see [[Q-9 quiet receiver]]) adds roughly a day.

## Test stand

Cold bay 2 and Cold bay 3 share the Test Stand 2 helium compressor but have separate cold heads and separate neon loops. Cold bay 3 was commissioned in May for the empty-dish repeat; its loop was cleaned and baked before cool-down, and its cold fixture was autoclaved. Cold bay 2's loop was cooled down on 26 February and has run since, apart from the warm-up for the 3 March post-run inspection. The 9 April transient was a blip, not a warm-up.

## Notes

> [!note] Dario, 18 May
> Somebody asked why Cold bay 2's cold head ticks when the array is not running. It doesn't. The cold head is a cold head. What ticks is not ours.

> [!note] Brannoc
> Dario, please keep editorial comments out of plant notes.
>
> Dario: Fair. Leaving it, though.
