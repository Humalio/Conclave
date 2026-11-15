---
owner: The Annex
status: active
depends_on: ["[[Signal paths]]"]
tags: [structure, tower, mount]
---

# Dish mount reinforcement

Design of the new mount structure that carries the feed ring. Owner: Rafi. Revision B, 20 May 2191. Install method is the keepers': see [[Dish mount installation]].

## What we are adding

The feed ring cannot sit on the existing tower frames; they were sized for an instrument bay and a reactor's heat rejection, not for a ring of magnets pulling inward with 7.9 MN. [[Signal paths]] sets the loads. This note sets the steel, or rather the titanium.

| Item | Qty | Material | Mass each | Total |
|---|---|---|---|---|
| Mount stubs | 24 | Ti-6-4 forging | 408 kg | 9.8 t |
| Frame doublers, frames 41–47 | 7 sets | Ti-6-4 plate, 14 mm | 2.09 t | 14.6 t |
| Frame 44 web insert | 1 | Ti-6-4 plate, 22 mm | 1.3 t | 1.3 t (included in doublers) |
| Shear ties, stubs to frames | 96 | Ti bolt groups | none | in stubs |

The backing ring itself is owned by Relay Engineering through [[Dish array design]]; we only design what it sits on.

## Frame 44

Frame 44 has a margin of +0.06 under LC-3, a single-horn surge. That is too thin for a frame we cannot easily inspect once the ring is in. The fix:

1. Replace the frame 44 web between stations 3 and 9 with a 22 mm insert.
2. Add a fifth shear tie at the old instrument-bay mount.
3. Remove the mount itself. Case Command has confirmed the instrument it carried was retired in 2184.

Margin after fix: +0.27.

## Joints and access

- Stubs bolt to doublers; doublers are bonded and riveted to the original frames. No welding near the original 2171 structure, whose weld records are incomplete.
- Every stub has an inspection port facing aft. After the ring is installed, ports are the only way to see the stub roots.
- Doublers on frames 41 and 47 run under the cable trays; see [[Cable routing]] for clearances.

## Thermal

The stubs are warm structure. The backing ring runs near ambient; only the horns (inside their cases) and the shroud are cold. The [[Shielding interface]] brackets carry the thermal break, so nothing in this note sees below 250 K. Stated here because someone asks every review.

## Status

- Rev A, 2 Apr: initial.
- Rev B, 20 May: frame 44 insert; instrument-bay mount removal.
- Forgings ordered 22 May; first delivery to Tern-9 due 14 July.

## Review

> [!note] Halden, 20 May
> Frame 44 fix is good. The +0.27 assumes the as-built frame matches the 2171 drawing. The keepers have already found two rivet rows that don't. I'd hold the margin until the frame 44 survey is in the Station log.
>
> Rafi: Agreed. Margin provisional until we've reviewed the keepers' frame 44 readings.
