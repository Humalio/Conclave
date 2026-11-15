---
owner: Signals Lab
status: active
depends_on: ["[[Literature - Sato-Oyelaran clock stability]]"]
tags: [signals, echo, geometry, fld]
---

# Echo geometry

The shape of the beam Tern-9's dish must produce, and the petal arrangement that produces it. This is the root of the echo chain: [[Lead time vs transmit power]] is computed on this geometry, and both the [[Dish array design]] and the [[Relay clock design]] inherit from that. Owner: Orla. Last revised 22 May.

## The dish ring

Twelve cryo-cooled feed petals sit in a ring round the main reflector of Tern-9, at 30° spacing. Each petal is a flattened trough, its long axis tilted 14° out of the reflector plane so that neighbouring petals overlap in projection. The tilt is what makes the twelve feeds behave as one phased aperture rather than twelve separate horns.

![[tern9-station.svg]]

| Parameter | Value |
|---|---|
| Number of petals | 12 |
| Angular spacing | 30° |
| Petal tilt out of reflector plane | 14°, alternating sign |
| Ring mean diameter | 11.2 m (reflector outer radius about 4.5 m at the cold face) |
| Nominal PA drive current at P 0.62 | 18.4 A |
| Pattern symmetry | 12-fold, with a 6-fold sub-pattern from the alternating tilt |

The alternating tilt is a choice, not a law. Sato and Oyelaran showed that a ring with uniform tilt has a soft mode at low power that the alternating ring does not ([[Literature - Sato-Oyelaran clock stability]]).

## The reply path

Inside the ring the beam forms what the team calls the **beam well**: a lens-shaped region, longest along the boresight, through which Tern-9 talks to the Net and, one day, hears the reply. The cold receiver face sits in its flattest part. Tern-9 is the last of forty relays; the next nearest is eleven light-hours back along the line.

![[relay-net-map.svg]]

Three features matter for everyone downstream:

1. **The rim.** At the petal ring the field gradient is steepest. The cold receiver face sits just inside it, at 40 K, between the feed and the reflector. Its job is to keep the receiver front end quiet. It is also where the frost grows.
2. **The floor.** In the middle of the beam the field is nearly uniform. Transmit power P is defined on the floor, at the sample coupler, not at the rim.
3. **The lips.** Fore and aft, the beam closes. These are where the receiver rings down after a transmission; see [[Echo decay]].

## The dish house

The test stand in Tern-9's dish house holds the cold fixture, which carries six receiver cells RC-1 to RC-6 on the cold face, at the rim position. Power is quoted at the sample coupler throughout the vault, so "P 0.34 on echo 47" means the coupler read what a clean drive would read at P 0.34.

The cold fixture's backing plate is [[Dish panel 7 (the one nobody ordered)]].

## What the geometry does not include

The geometry is purely electromagnetic. It treats the cold receiver face as a passive boundary with a fixed conductivity at 40 K. It has no mechanical modes, no acoustic response and no frequency content above the PA switching band.

That was a deliberate simplification in January. It is listed now as item 4 in [[Open questions]], because the strain channel on echo 47 contains a line at 1.92 kHz that nothing in this geometry would excite.

> [!note] Orla
> Geometry is the one part of this case I would still sign today. Everything that has gone strange has gone strange downstream of it. Or, as Imani keeps writing in the margin, alongside it.
