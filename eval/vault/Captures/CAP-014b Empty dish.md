---
owner: The Annex
status: paused
depends_on: ["[[CAP-014 Air-gapped capture]]", "[[Capture rig geometry]]"]
tags: [frost, empty-dish, receiver-bay, mystery]
---
# CAP-014b Empty dish

Capture lead: Hesper. Requested by Xenobiology (Ayo) on 22 April, to answer [[Frost is a contaminant]]: did the frost on the bay 2 tiles make the echo? Rig: Vesna. Receiver bay 3, Tern-9 dish test stand. Started 6 May 2191.

## Purpose

Listen again with nothing alive anywhere near the receiver. If the echo stops once the frost is gone, the frost made it. If the echo stays, the frost did not, and we have learned only that. Nobody planned for the third case.

## How it differs from normal listening

| | Bay 2 (frost mapped 11 Apr) | Bay 3 (CAP-014b) |
|---|---|---|
| Face | Tiles T-1 to T-6, faint frost at nine spots | Spare face, scraped clean, baked 36 h at 340 K, wiped, swabbed |
| Dish frame | Dish panel 7 in place | Same dish frame, same panel 7 |
| Frost present | Yes (mapped 11 Apr) | None. Swabs at 0, 100, 250 transmissions: negative |
| Receive chain | Relay firmware build 7, ORRIN in loop | Same. This is not a firmware test; that is [[CAP-014 Air-gapped capture]] |
| Step to p 0.33 | Not run | Transmission 101 |

Method otherwise identical to normal listening, sentence for sentence. Bay 3 cycles faster because it has no other users.

The step to high power was the point: Xenobiology wanted an answer before CAP-014 reached block B. Running at p 0.33 needed a waiver of the 4 March cap. Waiver W-07 was signed on 5 May, for bay 3 only, by I. Calloway of the director's office. The director's office did not usually sign test waivers. Saoirse asked why. The answer was "because I want to see it".

## Log

```
06 May 09:10  start. p 0.25. 40.0 K.
14 May        tx 100. no early replies. swab neg.
15 May 16:02  tx 101. p 0.33 (W-07). early reply, 0.71 s ahead. 1.92 kHz line in strain ch, all six tiles.
21 May        tx 250. early replies on 150 of 150 above 0.32. swab neg.
27 May 11:30  tx 450. early replies on 350 of 350. strain RMS +18 %. unscheduled scan.
27 May 14:45  2.3 GHz ring probe: standing-wave indications, all six tiles.
27 May 17:20  20x optical and probe map: ring nodes at 9 sites. spacing even.
27 May 17:40  hold. face sealed. nothing touched.
```

## Result at 450 transmissions

The echo arrives on **350 of 350** transmissions above 0.32. Ring nodes at **9 sites**. All of them wrong.

- None is at the feed throat. The throat is where the [[Capture rig geometry]] puts the standing-wave maximum.
- They sit between the twelve fixed probe sites, so [[cap-014-echoes.csv]] files each one under its nearest site and looks almost tidy. The probe sheets do not.
- Laid over the bay 2 frost map, all nine fall on the positions where the frost grew on the bay 2 tiles, within 0.4 mm. See the overlay in the frost map of [[CAP-014 Air-gapped capture|CAP-014]] and [[frost-node-map.svg]].
- Neighbouring nodes are evenly spaced. Rafi measured it twice.

## What this rules out

The frost did not make the echo. There was no frost here. Swabs negative, face baked, nothing alive in the bay. Xenobiology's hypothesis is answered, and Ayo has been told.

Hesper reads it the other way round: same dish, no frost, still an early reply, so build 7 must be bad. That is now [[B-01 Firmware 7 fault]].

## What it doesn't explain

Why a face that has never held anything alive rings in exactly the places where something alive chose to sit, on a different face, six weeks earlier.

The frost did not make the echo. It found where the echo was going to ring.

> [!note] Halden, 28 May
> A bad build stamps one time wrong. It does not ring on a ruler. What is spaced at regular intervals on a cold plate? I know the answer from first-year signal theory and I don't like it.

Run held at transmission 450 since 27 May. Resumption needs Disclosure Board agreement.

Saoirse says the director has a theory. It is not in any folder I can read. [[What answers us]]
