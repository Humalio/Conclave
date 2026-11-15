---
owner: The Annex
status: active
depends_on: ["[[Dish array design]]"]
tags: [structure, loads, signal]
---

# Signal paths

Where the dish's loads and signals go once they leave the feed ring. Owner: Hesper. Revised 12 May 2191.

## The problem in one paragraph

Relay Tern-9 was built in 2171 to carry a receiver mast and a reactor aft. Nobody drew its tower expecting twelve superconducting feed horns, a cryogenic shroud and their loads hanging off it. The feed ring sits between stations 41 and 47. The original tower carries axial loads through four longerons and hoop loads through the frames. The new array adds a large inward hoop load at ramp, a sudden release at send, and a vibration spectrum on top. All of it has to reach the main structure without tearing the tower frames or pushing the keepers' quarters forward of station 38. The same path carries the receive signal from the cold face to the relay controller, so what shakes the structure also shakes the data.

## Load cases

| Case | Description | Peak load at ring | Path |
|---|---|---|---|
| LC-1 | Full ramp, power 0.62, 18.4 kA | 7.9 MN inward hoop, distributed | horn cases → backing ring → tower frames |
| LC-2 | Send, 40 ms | release of LC-1 in 40 ms | same, reversed; dynamic factor 1.6 |
| LC-3 | Single-horn surge | 1.1 MN asymmetric, one bay | backing ring → two frames, torsion |
| LC-4 | Pointing slew, 0.3 g lateral | 2.4 MN | existing longerons |
| LC-5 | Dock loads during supply drops | crane lift points | see [[Supply drop plan]] |

Horn loads come from [[Dish array design]]. The dynamic factor on LC-2 is a placeholder until [[CAP-016 Live listen]] gives us real strain data at full scale; the subscale records are not representative.

## Path

1. Horn cases bolt to a **backing ring**, a closed titanium box section, 600 × 400 mm.
2. The backing ring rests on 24 **mount stubs**, new structure designed in [[Dish mount reinforcement]].
3. The stubs carry load into the existing frames 41–47, which are doubled.
4. The receiver shroud does not carry primary load. It hangs from the backing ring on the [[Shielding interface]] brackets, which are designed to be soft in the hoop direction so the shroud does not see the ring's strain.

![[tern9-station.svg]]

## Margins

| Member | Case | Margin |
|---|---|---|
| Backing ring | LC-1 | +0.44 |
| Mount stubs | LC-2 | +0.21 |
| Frame 44 web (original) | LC-3 | **+0.06** |
| Longeron splices | LC-4 | +0.31 |

Frame 44 is the tight one: it already carries the old instrument-bay mount. The fix is in Dish mount reinforcement.

## Mass

Structure added for the array: 38.6 t (ring 14.2 t, stubs 9.8 t, frame doublers 14.6 t). This is inside the refit mass budget that [[Refit plan]] tracks against R8.

## Review

> [!note] Halden, 12 May
> LC-2's dynamic factor of 1.6 assumes the send is the fastest event the structure sees. If anything rings faster than 40 ms, the factor is meaningless. I'd like one sentence on what we'd do if the live listen shows content above the band.
>
> Hesper: One sentence: re-run with the measured spectrum. Satisfied?
>
> Halden: No, but it's honest.
