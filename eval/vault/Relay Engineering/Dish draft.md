---
owner: Relay Engineering
status: draft
depends_on: ["[[Echo geometry]]"]
tags: [dish, draft, superseded]
---

# Dish draft

Dario's working draft of the dish array, January to March 2191. Superseded by [[Dish array design]] (Revision 4). Kept because Brannoc said "keep your workings" and nobody has told Dario to stop.

## Horn layout (Jan)

~~14 horns~~ ~~16 horns~~ **12 horns.** Brannoc: twelve. Fourteen gives a cleaner beam at the focus but the backing ring has to be split at station 44 and nobody wants that conversation with the Authority.

Racetracks, roughly 2.8 × 0.9 m at the inner ring. Tilt TBD. Tried:

| Tilt | Beam at focus | Note |
|---|---|---|
| 0° | flat, ugly | rays cross the focal plane square-on; [[Echo geometry]] says no |
| 10° | better | still too steep |
| 14° | good | alternate horns lean into each other |
| 20° | over | neighbours start fighting; wind-up load +30 % |

→ 14°, alternating. Looks like a fan in the sketch. (Sketch is on the back of a cryo order. Scanned? No. TODO.)

## Power (Feb)

Transmit power 0.62 needed for the design burst. Signals Lab's curve is roughly lead time ∝ P². First pass: **17.6 kA** at the amplifier. Second pass with Teodor's updated exponent: 18.4 kA. Third pass with Imani's error bars: anywhere from 17.9 to 19.0, which is not a pass, it is a shrug.

Critical current of the feed superconductor at 18 K: 22.1 kA → margin 16.7 %. At 20 K: ~14 %. **Below R3.** Flag to cryo. (Flagged. Cryo is me. Noted.)

## Ideas that did not survive

- Two rings of six horns, offset axially. Beam nice. Mass awful. Killed by Kemi in four words.
- A bare-tape feed without a copper channel. Cheaper. Lusa explained hot spots to me with a drawing of a toaster. Killed.
- Putting the receivers outside the dish instead of at the focus. I still think about this one. It would keep the transmit field off the receivers completely. It would also put it on the keepers. Killed.

## Bench numbers (Mar)

Bench transmissions up to listen L-02 match the scaled beam within 3 %. Listen L-03 (echo 47) does not match anything. Not using it. ~~Possible feed fault?~~ Lusa checked: no. ~~Clock?~~ Timekeepers say no. ~~Me?~~ Brannoc says no, which was kind.

Bench cap power 0.30 from 4 March. Re-ran the power curve below the cap only. Clean. Nothing odd below 0.30.

## Open (as of when I stopped)

1. Bracket count for the receiver shroud: 24? 48? → became 48, see [[Shielding interface]].
2. Who owns the backing ring? → us.
3. Why does the scratch file keep growing → see [[scratch]].

> [!note] Brannoc, 9 March
> This is fine as a workbook. Please don't link it from anything a reviewer will read. Rename it when you get round to it.
