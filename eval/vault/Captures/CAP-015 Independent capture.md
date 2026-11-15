---
owner: The Annex
status: draft
depends_on: ["[[Q-9 quiet receiver]]", "[[Capture rig geometry]]"]
tags: [q-9, independent, backup, plan]
---
# CAP-015 Independent capture

Plan only. No receiver built, no rig, no results. Drafted by Vesna, 12 May 2191; costed by Rafi, 19 May. Owner: Hesper.

## Purpose

The backup campaign. If [[CAP-014 Air-gapped capture]] shows the echo survives without firmware, or the qualification rule moves, the receiver goes to [[Q-9 quiet receiver]], and Q-9 has no capture data at all. This capture would give it the same 600 high-power transmissions the air-gapped rig is getting, on the same terms, at a second site, so the two can be compared line for line.

Q-9 is heavier: 11 % more receiver mass, which [[Power budget]] and R8 (refit adds ≤ 6 % station mass) will both notice. Its band edge sits lower and tighter than the build 7 receiver's (see the band table in [[Q-9 quiet receiver]]). Nobody has said whether that matters for the capture. The plan below does not assume it does.

## Plan

- Receivers: one Q-9 front end, built to the drawing in [[Capture rig geometry]] from a development unit. Designation Q-1.
- Method: as CAP-014, sentence for sentence, with one change: ring-band sampling at 20 kHz instead of 10 kHz.
- Schedule: transmissions 1–200 at p 0.25; transmissions 201–800 at p 0.33, subject to the same pending echo model update as CAP-014.
- Ring-band probe scans at 200, 400, 600 and 800 transmissions.
- Pass criterion: an early reply logged on 600 of 600 transmissions above 0.32, with no ring line inside the Q-9 band.

> [!note] Vesna, 12 May
> The 20 kHz was Imani's request. Her reason, in full: "just in case". I asked in case of what. She said she'd tell me when she could prove it.

## Where it runs

Not on the Tern-9 test stand. Bay 2 is booked by CAP-014 through June and bay 3 by [[CAP-014b Empty dish]]. A second dish is a quarter's work for the refit team.

The external route: **the Night Choir**, amateur listeners with a receiver array in a similar band and a year of logged echoes. They are being approached through Case Command. No agreement, no quote, no date. Saoirse has had one call with them. They asked for the CAP-014 method and the run history of our rig. We sent the method.

## Cost and duration

| Item | Estimate |
|---|---|
| Q-9 front end, one unit | 3 weeks lead from order |
| Transmissions, 800 at ~20 per day | 7 weeks |
| Probe analysis and report | 2 weeks |
| Total from go | ~12 weeks |

Twelve weeks from go puts the earliest result past M3 (due 31 July) whatever day we start. That is the reason CAP-015 is a draft and not a plan of record: on 1 June, CAP-014 block A is done with no early replies, and [[B-01 Firmware 7 fault]] asks for a new build, not a new receiver.

## Open

1. Do we send the Night Choir the run history, including echo 47? Saoirse says not without the director. The director has not answered.
2. Does the Q-9 front end come from Pellam Systems, who made build 7? If B-01 is right about build 7, that question gets louder.
3. What power does "operating power" mean if the echo model update is late?
