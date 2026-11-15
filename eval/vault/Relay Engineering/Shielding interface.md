---
owner: Relay Engineering
status: active
depends_on: ["[[Dish array design]]", "[[Firmware 7]]"]
tags: [shielding, interface, shroud]
---

# Shielding interface

How the receiver shroud hangs from the dish backing ring. Owner: Dario, with The Annex. Revision 3, 21 May 2191. Covers the mechanical, thermal and signal-face interfaces between the backing ring (ours) and the shroud around the cold receivers (the Annex's quiet-receiver work).

## The tie

The shroud does not touch the feed horns. It sits 300 mm inside the horn cases and hangs from the backing ring on **48 brackets**, two per shroud segment, landing on the bracket bosses machined into each segment.

![[tern9-station.svg]]

Each bracket is a titanium flexure with a glass-fibre thermal standoff:

| Part | Material | Function |
|---|---|---|
| Ring clevis | Ti-6-4 | bolts to the backing ring, ambient |
| Thermal standoff | glass-fibre tube, 240 mm | thermal break, 293 K → 40 K |
| Flexure blade | Ti-6-4, 3 mm | soft in hoop, stiff radially and axially |
| Boss pad | Invar, bonded | matches shroud contraction at 40 K |
| Boss bolt | A286, M16 | through the shroud boss |

## Why flexures

The backing ring moves. At full transmit power the feeds pull it inward 2.1 mm and it springs back in 40 ms at send. If the shroud were bolted rigidly, it would see that hoop strain every transmission. The flexure lets the ring breathe while the shroud stays put. Hoop stiffness 1.8 kN/mm per bracket; radial 210 kN/mm.

So by design the shroud's only significant loads are its own thermal contraction, its weight, and whatever the signal does to it directly. That last item is the one the [[Timestamp fault model]] was meant to estimate, and the one [[CAP-014 Air-gapped capture]] tests. If [[Firmware 7]] turns out to be the whole story, the shroud is over-built; nobody is lowering the bracket count to find out.

## Thermal

| Path | Heat to 40 K |
|---|---|
| 48 brackets | 0.62 kW |
| Radiation through MLI | 1.35 kW |
| Instrument leads | 0.23 kW |
| **Total** | **2.2 kW** |

This is Loop B's load in [[Cryo plant]].

## Signal face

The shroud's inner face looks at the cold receivers. The interface rules:

1. No metal fasteners on the signal face. Boss bolts are counter-sunk and capped with plastic plugs.
2. Bracket bosses sit four to a bay, symmetric about the horn-bay centreline, not between horns, so they see the gentlest part of the field.
3. Strain gauges at 12 bosses, one per bay, on the station as on the bench.

Point 2 is the one to re-check if [[Echo geometry]] changes. Boss positions are tied to horn positions.

## Receiver sensitivity

The boss pad is Invar because Invar's contraction at 40 K is close to the shroud's (0.21 %). If the shroud is changed to carry the [[Q-9 quiet receiver]] (lower modulus, same contraction within 0.02 %), the pads stay and the brackets need a two-day re-run for the stiffer-relative-to-shroud case.

## Bench equivalent

The cold fixture in Cold bay 2 is the bench version of one bay: a backing plate, six receiver blocks on bosses, flexure-mounted to the fixture frame. The backing plate is station stock, cut from a spare panel found in the Tern-9 stores. The Cold bay 3 fixture is new-build. See [[Dish panel 7 (the one nobody ordered)]].

> [!note] Dario
> If I were writing this again I'd use fewer brackets. Forty-eight of anything is forty-eight ways to be wrong.
