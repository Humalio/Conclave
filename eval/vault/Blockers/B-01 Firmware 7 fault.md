---
owner: The Annex
status: open
depends_on: ["[[CAP-014 Air-gapped capture]]", "[[Firmware 7]]"]
tags: [blocker, firmware-7, build-lot-7, m3]
---
# B-01 Firmware 7 fault

Opened by Hesper, 28 May 2191. Blocks: M3 (explanation qualified), and through it [[Dish array design]] and M4. Assigned: the Annex. Escalation: Saoirse (Case Command).

## Summary

The empty-dish capture [[CAP-014b Empty dish]] logs the echo on 350 of 350 transmissions above 0.32, on a face scraped, baked and swabbed clean. Its receivers run the same firmware as every other dish on Tern-9: build 7, **B7-L07** ("build lot 7") from Pellam Systems. The frost hypothesis is dead (no frost in bay 3), so the common factor is the firmware. Build lot 7's release notes have a traceability gap. Until the build is cleared or replaced, Firmware 7 cannot be qualified as the explanation against R4, and the patch cannot go out to the Net.

## Background

The relay firmware is removed from the receiver chain and ORRIN is disconnected from the dish and from the relay clock, so no software stamps anything. A hand-clocked receiver (a quartz reference read and stamped by a keeper, logged on a paper tape and a stand-alone recorder, with no network connection) times every transmission and every arrival. 600 transmissions above transmit power 0.32 are sent in the test block, after a control block at 0.25. The tape is read out in one pass after the 600th transmission, by someone who did not run the rig.

That is [[CAP-014 Air-gapped capture]], quoted from its method. It is the only capture on Tern-9 with no build 7 in the loop, and its result is pending.

## Why build lot 7

The release notes for B7-L07, as filed with [[Vendor audit]]:

| Line | Expected | In the release notes |
|---|---|---|
| Regression soak trace | Continuous, 0–22 h | Hours 0–14 and 20–22 only. Hours 14–20 "trace not retained" |
| Build hash | Printed from the build system | Handwritten, initialled, no build printout |
| Cold screen | 50 cycles, 300 K ↔ 40 K | "Per standard" |
| Board map | Boards 1–14 with positions | Boards 1–13 only. Board 3, our dish rack, has no position |

Hours 14 to 20 are the soak at full receive load. That is where a stale-register fault would hide. A fault like that would not show at low power, which is why [[CAP-012 Baseline listen]] passed, and it would show at high power, which is what CAP-014b found.

This is not proof that build 7 is bad. It is proof that we cannot show it is good, and R11 does not let us qualify an explanation on release notes with six hours missing.

## Impact

- [[Firmware 7]]: the qualification line cannot close.
- M3 (due 31 July): at risk. M4 depends on it.
- [[Q-9 quiet receiver]] and [[CAP-015 Independent capture]]: not triggered by this blocker. A reflash with a clean build is the cheaper fix.
- [[Annex risks]]: the build-traceability risk goes from amber to red.

## Asks

1. Pellam Systems to supply the full soak trace for B7-L07, or reissue the release notes with it.
2. Quarantine remaining build lot 7 boards at Tern-9.
3. Quote and lead time for a clean build 7 reflash across the Net.
4. Keep CAP-014 running. Data from a suspect build is still data, and CAP-014 has no build in it.

## Updates

- 28 May, Hesper: opened.
- 29 May, Hesper: Corin Ashdale (procurement liaison) says he will take the release notes up with Pellam directly, today. Good. Faster than going through procurement.
- 30 May, Vesna: Pellam acknowledged. No date.

## Review

> [!note] Halden, 30 May
> I'll sign the traceability point; the release notes are a mess. I won't sign the cause. A stale register is stale at every power. This echo comes only above 0.32, always 0.71 s, and on the empty dish it rang at nine evenly spaced nodes, every one of them where the frost used to sit on the other face. Build 7 is a story about paperwork. The node map is a story about something else. Before we blame a vendor, somebody should look at the map, and wait for the capture that has no firmware in it.
>
> Hesper: Noted. The map is in CAP-014. I have looked at it. I do not have a mechanism for it, and I do have release notes with six hours missing.
>
> Halden: Then we wait for the tape. If the echo is on it, this blocker is blaming the only thing in the building that isn't there.
