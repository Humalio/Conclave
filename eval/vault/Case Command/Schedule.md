---
owner: Case Command
status: active
depends_on: ["[[Milestones]]", "[[Refit schedule]]"]
tags: [case-command, schedule]
---

# Schedule

The case schedule at month resolution. Day-level detail lives in team schedules, principally the [[Refit schedule]]. Milestone definitions live in [[Milestones]]. Baseline set 6 January; this is re-plan 3, issued 30 May.

![[case-timeline.svg]]

## Phases

| Phase | Window | What happens | Ends with |
|---|---|---|---|
| 0. Definition | Sep 2190 – Jan 2191 | Charter, requirements, team stand-up, Firmware 7 baselined | Charter rev C |
| 1. Characterisation | Jan – Jun 2191 | Live-listen campaign, baseline listens, holdover, echo model | M1 (30 Jun) |
| 2. Design and qualification | Jun – Sep 2191 | Dish design review, air-gapped capture, full live listen | M2 (15 Jul), M3 (31 Jul), M4 (30 Sep) |
| 3. Refit | Oct – Dec 2191 | Dish mount, dish array, shielding, power train, bunks installed at Tern-9 | M5 (15 Dec) |
| 4. Disclosure | Dec 2191 – Jan 2192 | Disclosure case closed, independent review, disclosure order | M6 (31 Jan 2192) |
| 5. Reply | Feb – Mar 2192 | Keeper training, systems checkout, the first deliberate reply | M7 (target 1 Mar 2192) |

## Key dates, next eight weeks

| Date | Event | Owner |
|---|---|---|
| 1 Jun | CAP-014 block A complete at 200, no early replies | Tern-9 test stand |
| 2 Jun | Case kickoff for the qualification phase | Saoirse |
| 3 Jun | CAP-014 enters transmissions 201–800 at power 0.33, if the cap is raised | The Annex |
| ongoing | CAP-014b held on the empty dish, pending Disclosure Board | The Annex |
| 30 Jun | **M1** Echo model frozen | Signals Lab |
| 15 Jul | **M2** Dish design review | Relay Engineering |
| 31 Jul | **M3** Explanation qualified (CAP-014 tape read out after 800) | The Annex |

## Assumptions

1. The test stand is available five nights a week. CAP-014 and its empty-dish twin share the cryo plant; see [[Cryo plant]].
2. CAP-014 sends roughly 25 transmissions per night watch. 600 remain on 1 June: about 24 watches, so transmission 800 and the tape read-out land in mid-July, inside M3 with about eleven working days' float.
3. The 0.30 cap is lifted in time for [[CAP-016 Live listen]] to reach operating power before 30 September. **This assumption has no owner.** It is listed here because the schedule is meaningless without it.
4. The supply drop window opens 6 October and closes 19 December. See [[Supply drop plan]].
5. The flight relay clocks arrive by end of August; see [[B-02 Clock vendor delay]].

## Changes since re-plan 2

- CAP-014b added in May. No schedule cost: it runs on the second feed, one block ahead of CAP-014.
- Echo model v2 moved from "May" to "June". M1 date held.
- Bunk shielding moved earlier in the refit sequence because the [[Bunk shielding spec]] is ready and the dish array is not.

## Schedule risk

The [[Risk register]] holds the detail. In one sentence: the schedule is a chain of four gates, the second of which (M3) is on a capture running above the case's own power cap, and the third of which (M4) cannot happen until that cap is lifted.

> [!note] Saoirse
> I have built schedules for relays that had never been built. This is the first one I have built where a date depends on a reason I am not cleared to read.
