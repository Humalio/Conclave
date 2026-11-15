---
owner: The Annex
status: running
depends_on: ["[[Capture rig geometry]]", "[[Lead time vs transmit power]]"]
tags: [firmware-7, air-gapped, m3, receiver-bay]
---
# CAP-014 Air-gapped capture

Capture lead: Hesper. Rig: Vesna. Inspections: Rafi, with Bel Arkwright on the cryo side. Started 20 April 2191, receiver bay 2, Tern-9 dish test stand. Raw transmission log: [[cap-014-echoes.csv]].

## Purpose

Settle whether the early reply belongs to the relay's software or to the signal itself. The Firmware 7 explanation qualifies for milestone M3 (explanation qualified) only if it survives a capture with no firmware in the loop. If the echo vanishes, [[Firmware 7]] stands and its patch goes ahead. If the echo stays, Firmware 7 falls, and the receiver replacement goes to [[Q-9 quiet receiver]] and [[CAP-015 Independent capture]], which has no rig.

## Method

The relay firmware is removed from the receiver chain and ORRIN is disconnected from the dish and from the relay clock, so no software stamps anything. A hand-clocked receiver (a quartz reference read and stamped by a keeper, logged on a paper tape and a stand-alone recorder, with no network connection) times every transmission and every arrival. 600 transmissions above transmit power 0.32 are sent in the test block, after a control block at 0.25. The tape is read out in one pass after the 600th transmission, by someone who did not run the rig.

![[capture-rig.svg]]

The six cold-face tiles (T-1 to T-6) stay mounted; T-3 was swapped for replacement tile T-3R on 15 April after the frost sample was taken. Receiver face held at 40 K, logged at 1 Hz. Face inspected by 20× optical and by ring-band probe at transmissions 100, 200, 400 and 800.

## Schedule

| Block | Transmissions | Transmit power p | Basis |
|---|---|---|---|
| A | 1–200 | 0.25 | Inside the 4 March cap of p 0.30; control and rig shakedown |
| B | 201–800 | 0.33 | Above the 0.32 line, per the echo model update (pending) |

Block B needs the p 0.30 interlock raised for the air-gapped rig. That needs the echo model update, which is Signals Lab's (M1, due 30 June). If the update is late, block B waits and the campaign clock stops at 200.

> [!note] Vesna, 1 June
> Block A is the easy half. Everyone knows it. The [[Timestamp fault model]] says nothing early arrives at 0.25, so we are not learning much here except that the rig works.

## Status

| Date | Transmissions | Note |
|---|---|---|
| 20 Apr | 0 | Start. T-3R mounted 15 Apr in T-3's position. |
| 2 May | 100 | Inspection: clean. Hand clock checked against the quartz reference. |
| 17 May | 150 | Control clean, all channels. |
| 1 Jun | 200 | Block A complete. No early replies at 0.25, as modelled. Block B waits for the cap raise. |

Strain: no channel outside the model band so far. Face temperature held 40.0 ± 0.3 K.

## Result

Pending. Block A is complete and the high-power block has not started. The hand-clocked tape will be read out in one pass after the 600th transmission above 0.32, so there is no partial result to quote.

## Frost map

No result exists yet on CAP-014. The map below is here anyway, because it belongs to this rig's receiver face more than to any other note.

![[frost-node-map.svg]]

It overlays two layers on the same face outline. The first layer is the frost positions: the places on the bay 2 tiles where Bel Arkwright mapped glassy film after the 9 April alarm, once the specimen itself had gone to the sealed cell (see [[Frost feeding log]]). The second layer is the ring nodes found on 27 May in [[CAP-014b Empty dish]], the empty-dish twin of this campaign in bay 3.

Nine nodes. Nine frost spots. They sit on top of each other.

None of the nine is at the feed throat, where [[Capture rig geometry]] puts the standing-wave maximum and where every ring node is supposed to sit. They run across the face at a regular spacing, as if somebody had ruled them in.

Bay 3 never held a colony. Its face was scraped, baked and swabbed. Whatever put ring nodes where the frost used to be, it was not the frost.

Block B starts at transmission 201, at power 0.33, the power at which CAP-014b first heard the echo.
