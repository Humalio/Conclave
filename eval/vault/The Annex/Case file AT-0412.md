---
owner: The Annex
status: active
depends_on: ["[[Firmware 7]]", "[[Shielding interface]]"]
tags: [case, at-0412, working-file]
---

# Case file AT-0412

Vesna and Halden's working file on the early replies. Owner: Vesna. Last revised 22 May 2191. Halden was sent to the Annex to close it; he reads every line before it goes anywhere.

## What the case is

Case AT-0412 opened as a clock-noise ticket and stayed open because Vesna kept a log. The Annex is three desks in the Corvel Station basement, and this file is the shared desk: every echo, every source, every claim, with who made it and what it rests on.

- Echoes 1 to 46 were filed as clock noise.
- [[Echo 47 (why we stopped)]] is the first nobody could explain.
- Vesna's wall is at home. This file is the version Halden will sign.

![[tern9-station.svg]]

## Working method

| Step | Who | Time | Hold point |
|---|---|---|---|
| Log the echo | Vesna | 3 h | transcript, relay clock, source |
| Cross-check the clock | Rafi | 9 h | second timestamp present or absent |
| Pull the vendor record | Hollis | 22 h | release record complete |
| Reproduce on the bench | Rafi | 5 h | power, band, buffer state |
| Independent read | Halden | 2 h | no claim without a source |
| Board check | Hesper | 20 h | nothing sent upwards unsigned |
| Wall update | Vesna | 12 h per echo | every pin has a note |

Throughput: Vesna can log two echoes a week and Halden can review one. Twelve weeks for a clean file, not counting rework. The first full entry (echo 47) went through all seven steps on 6 May and passed with one open item.

## Hold points that matter

1. **Release record.** Every firmware lot needs one. It is the document [[B-01 Firmware 7 fault]] is about: build lot P7-L07's record is missing the test trace for hours 14 to 20, the run at the peak of the conformance test, and the machine identity field for that stretch reads "transferred", with no machine named. Pellam says the trace is complete; Hesper says a trace with a six-hour hole and no machine is half a trace. See [[Vendor audit]].
2. **Second timestamp.** On echo 47 the relay clock logged the reply twice. A file entry without both stamps does not count. See [[Second timestamp]].
3. **Independent read.** Halden breaks every claim once. On echo 47 he found nothing at all, which Vesna logged as "suspiciously polite".

## If the explanation changes

[[Q-9 quiet receiver]] uses the same bench but a longer alignment of about 30 h. The instrument shop's schedule would not take that without moving another customer. Lead time to switch: about three weeks, plus a new format for the release record.

## Open items

- Cable shield for the 40 K run: foil chosen, bond strength at 40 K still from datasheet only.
- Transport: the cold crates hold 4 receivers. Tern-9 wants 6 per supply drop; see [[Supply drop plan]].
- Echo order: Dunmore wants the echoes at power 0.30 to 0.34 first, because those are the hardest to reproduce once the cap is back on.

> [!note] Halden, 22 May
> The method checks for the faults we know how to look for. Nothing here would catch a cause that is sound on the bench and then misbehaves in service. That is what CAP-014 is for. Make sure the plan doesn't assume it passes.
