---
owner: Relay Engineering
status: active
depends_on: ["[[Dish array design]]", "[[Capacitor bank]]"]
tags: [power, budget]
---

# Power budget

Energy and power for one design transmission, from reactor to feed array and back to quiet. Owner: Kemi. Revision 5, 28 May 2191. Feeds [[Disclosure case]] §4.

## The burst, in energy

![[power-flow.svg]]

| Stage | Duration | Energy | Peak power | Source |
|---|---|---|---|---|
| Bank recharge | 14 min | 2.10 GJ | 2.5 MW from reactor | [[Capacitor bank]] |
| Amplifier ramp | 90 s | 1.71 GJ into feeds | 23.3 MW from bank | [[Dish array design]] |
| Converter + cable loss | 90 s | 0.11 GJ | none | Lusa's estimate |
| Hold at power 0.62 | 11 s | ~0 (superconducting) | 0.4 MW cryo | [[Cryo plant]] |
| Send | 40 ms | 1.71 GJ to dump | none | [[Surge protection]] dump path |
| Reserve kept in bank | none | 0.28 GJ | none | controlled abort |

Bank total: 1.71 + 0.11 + 0.28 = 2.10 GJ. It closes, with nothing to spare and nothing missing.

## Where the energy goes at send

A normal send is the deliberate opposite of a surge: the switches open on the relay clock's command and the feeds' stored energy goes into the dump resistors in 40 ms. The resistors are water-cooled blocks below the transmit hall; they reach 410 K and take about six minutes to cool. Nothing comes back to the bank. A recovery converter was studied in March and dropped: it would save 1.7 GJ per burst and cost 9 t.

## Continuous loads during a transmission

| Load | Power |
|---|---|
| Cryo plant, feeds at 18 K | 310 kW |
| Cryo plant, shroud at 40 K | 85 kW |
| Converter standby | 40 kW |
| Relay clock and timing chain | 2 kW |
| Surge detection | 1 kW |
| **Total, continuous** | **438 kW** |

Cryo dominates. The shroud figure assumes the stock receivers. A heavier shroud raises the cold mass and the cool-down time; it does not much change steady power. Measured cryo heat loads are in [[dish-thermal.csv]].

## Margins

| Item | Margin | Comment |
|---|---|---|
| Bank energy | 15 % above burst + loss | the reserve |
| Reactor recharge power | 2.5 of 3.4 MW spare | station hotel load cut during ramp |
| Surge margin (feed current) | 16.7 % | see Dish array design |
| Dump resistor temperature | 410 of 500 K | |

## Sensitivities

- If [[Lead time vs transmit power]] moves the exponent from 2.0 to 2.1, current drops to 18.0 kA and stored energy drops 4 %. Good news; we would keep the bank.
- If a transmission needs more hold time, energy does not change but cryo load does: about 0.44 MJ of reactor energy per extra second.
- If the dish design changes (geometry or receivers), this note changes. That is why it depends on [[Dish array design]].

> [!note] Brannoc, 28 May
> Revision 5 accepted. Kemi, please keep the reserve line visible; reviewers keep trying to spend it.
