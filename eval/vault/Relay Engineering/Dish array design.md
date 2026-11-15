---
owner: Relay Engineering
status: active
depends_on: ["[[Firmware 7]]", "[[Echo geometry]]", "[[Lead time vs transmit power]]"]
tags: [dish, array, m2]
---

# Dish array design

Baseline design of the dish array for relay Tern-9 and the forty-station rebuild that would follow it. Owner: Brannoc. Revision 4, 27 May 2191. Goes to [[M2 dish design review]] on 15 July.

## Configuration

Twelve cryo-cooled **feed horns** sit at the focus of an 18 m dish built from 44 panels in two rings, between stations 41 and 47 of the support tower, at 30° spacing. Each horn is a racetrack winding tilted 14° out of the focal plane, alternating sign, so that neighbouring horns lean into each other like the slats of a half-closed fan. That tilt is what turns twelve feeds into one array: [[Echo geometry]] needs the beam to cross the focal plane at a shallow angle, and the tilt gives it.

![[relay-net-map.svg]]

| Parameter | Value |
|---|---|
| Feed horns | 12 |
| Focal ring mean diameter | 11.2 m |
| Dish panels | 44, inner ring (1–22) and outer ring (23–44) |
| Winding | racetrack, 2.8 × 0.9 m, 412 turns |
| Conductor | tape-in-channel, see [[Feed horn spec]] |
| Operating temperature | 18 K |
| Horn case | stainless, bolted to backing ring |
| Mass per horn (wound, cased) | 3.1 t |

The receiver shroud, at 40 K, sits inside the ring and carries no horn load. It hangs from the backing ring through the [[Shielding interface]]. The cold receiver face looks back at the inner ring, which is where the frost was found.

![[tern9-station.svg]]

## Operating point

The design case is the long-haul burst to the Kuiper edge: **transmit power 0.62 for 90 s**. [[Lead time vs transmit power]] gives lead time rising roughly with the square of drive current, which puts the nominal feed current at **18.4 kA**. The echo appears only above power 0.32; the design burst sits well inside that region, which is why the array is the thing people argue about.

| Quantity | Value | Note |
|---|---|---|
| Nominal feed current | 18.4 kA | power 0.62 |
| Critical current at 18 K, peak field | 22.1 kA | conductor data |
| Surge margin | **16.7 %** | R3 asks ≥ 15 % |
| Stored energy, full feed ring | 1.71 GJ | from 10.1 H ring inductance |
| Ramp time | 90 s | from [[Capacitor bank]] |
| Hold | 11 s | |
| Send | timed by [[Relay clock design]] | within 4 ns |

The margin is the number everybody watches. 1.7 points above the requirement is not a lot. It comes almost entirely from running at 18 K; at 20 K it falls below 15 %. [[Cryo plant]] owns that.

## Inputs we depend on

1. **Echo geometry** (Signals Lab): horn positions and tilt. Frozen at M1. Revision 4 uses the v1 geometry.
2. **Lead time vs transmit power** (Signals Lab): the lead-time curve. Our 18.4 kA moves if the exponent moves; at exponent 2.1 instead of 2.0 we need 18.0 kA.
3. **Firmware 7** (the official explanation): the design assumes the early replies are a timestamp fault in relay firmware build 7, so the receivers are specified with the stock firmware and a software patch. If that explanation fails, the receiver front end changes, the shroud loads change with it, and so does [[Power budget]] via the cryo load.

## Open items

- **OI-1.** Horn-to-horn force at a surge (LC-3 in [[Signal paths]]): 1.1 MN asymmetric. Backing ring OK; station 44 being reinforced.
- **OI-2.** Echo model v1 versus subscale data: listen L-03 reached power 0.34 at a drive that v1 says gives 0.25. That run is not used as design data. See [[Echo 47 (why we stopped)]].
- **OI-3.** Send dynamics: 40 ms ramp-down assumed. The live listen will tell; see [[CAP-016 Live listen]].

> [!note] Brannoc
> Revision 4 is the design we take to M2 unless Signals Lab moves the geometry. Revision 3 and earlier live in [[Dish draft]] and are not to be quoted.
