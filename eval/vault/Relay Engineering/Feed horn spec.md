---
owner: Relay Engineering
status: active
depends_on: ["[[Dish array design]]"]
tags: [feed, horn, manufacturing]
---

# Feed horn spec

How each of the twelve cryo-cooled feed horns is wound, plated and accepted. Owner: Lusa. Revision 2, 12 May 2191.

## Conductor

| Item | Value |
|---|---|
| Form | superconducting tape soldered into a copper channel ("tape-in-channel") |
| Tape width | 12 mm, four tapes stacked per channel |
| Channel | oxygen-free copper, 14 × 6 mm, RRR ≥ 150 |
| Insulation | polyimide wrap, 50 % overlap, 0.15 mm |
| Length per horn | 3.05 km |
| Spare | 2 horns' worth on the reel, held at the feed shop |

The copper channel is what makes the feed survivable: during a surge the current leaves the tape and rides the copper while [[Surge protection]] dumps the energy. Channel cross-section is set by the hot-spot limit, 120 K at the worst point.

## Winding

1. Wind on the horn former at 120 N tension, ±5 N. Tension logged every turn.
2. 412 turns in 14 layers. Layer-to-layer joints are not allowed; each horn is one continuous length.
3. Two voltage taps per layer for surge detection, soldered and potted before the next layer goes on.
4. Vacuum-impregnate with filled epoxy; cure 24 h at 80 °C, ramp no faster than 10 °C/h.
5. Close into the stainless case; shim to 0.1 mm.

> [!note] Lusa
> Tension variation is the thing that kills these feeds, not the conductor. A loose turn can move under load, rub, heat, and trip. Our tension log is the horn's medical record. Keep it with the horn forever.

## Acceptance

| Test | Condition | Pass |
|---|---|---|
| Turn-to-turn insulation | 1.5 kV pulse, all layers | no breakdown |
| Ground insulation | 5 kV DC, 1 min | < 1 µA |
| Cold test | 77 K, 2 kA, 10 min | taps balanced within 0.5 mV |
| Training run | 18 K, ramp to 19.5 kA | ≤ 2 training trips |
| Leak check | case, helium | < 1e-9 mbar·l/s |

Horns that need a third training trip go back to the shop. Of the four practice feeds wound since February, one needed two, one needed one, two needed none.

## Subscale

The bench array in Cold bay 2 uses twelve 1:20 horns wound to a scaled version of this spec (0.6 mm tape, 80 turns). They are not a model for winding quality, only for beam shape. Their training records are in the [[Dish test plan]].

## Changes

- Rev 1, 3 Feb: initial.
- Rev 2, 12 May: tension tolerance tightened from ±10 N to ±5 N after practice feed P-2 trained twice. Insulation wrap overlap 40 % → 50 %.

## Open

- Conductor (43 km: 12 horns plus spare) released at risk on 2 May, ahead of M2. Lead time 16 weeks; first reels due 22 August.
- The feed shop on Corvel Station has two formers. Twelve horns at nine days each is 54 working days on two formers, finishing early November if the reels are on time. That is the [[Refit schedule]]'s problem as much as ours.
