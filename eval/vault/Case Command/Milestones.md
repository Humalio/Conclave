---
owner: Case Command
status: active
depends_on: ["[[Disclosure case]]", "[[CAP-016 Live listen]]", "[[Refit plan]]", "[[Refit schedule]]"]
tags: [case-command, milestones]
---

# Milestones

Owned by Case Command (Saoirse). State as of 1 June 2191. Every milestone is open. Not one is green, and only two are honestly amber.

## Milestone table

| ID | Milestone | Due | Owner | Status | Gate evidence |
|---|---|---|---|---|---|
| M1 | Echo model frozen | 30 Jun 2191 | Signals Lab | Open, at risk | Echo model v2 issued and validated against Tern-9 data; supersedes [[Echo model v1]] |
| M2 | Dish design review | 15 Jul 2191 | Relay Engineering | Open | [[Dish array design]] passes [[M2 dish design review]] |
| M3 | Explanation qualified | 31 Jul 2191 | The Annex | Open, at risk | [[CAP-014 Air-gapped capture]] completes its 600 high-power transmissions; [[Firmware 7]] released (R4) |
| M4 | Live listen | 30 Sep 2191 | Case Command | Open, blocked | Full-power transmit and listen at Tern-9, [[CAP-016 Live listen]]; [[Power budget]] confirmed |
| M5 | Tern-9 refit complete | 15 Dec 2191 | Tern-9 Keepers | Open | Dish array, shielding, power train and bunks installed per [[Refit plan]] and [[Refit schedule]] |
| M6 | Disclosure approved | 31 Jan 2192 | Disclosure Board | Open | [[Disclosure case]] approved under [[Disclosure basis]] |
| M7 | First deliberate reply | 1 Mar 2192 (target) | Case Command | Scheduled | One controlled reply to the echo, sent and logged (R1) |

![[case-timeline.svg]]

## Gate evidence and dependencies

The milestones are a chain, not a list. Each gate consumes the results of the ones before it:

- **M1 → M2.** The dish is designed against the frozen echo model. If the model moves, [[Lead time vs transmit power]] moves, and the dish array moves with it.
- **M3 → M4.** No full-power live listen on an explanation we have not qualified. M3 rests on [[CAP-014 Air-gapped capture]], which is running with the result pending. Block A is complete; the high-power block waits on the cap raise, booked for 3 June.
- **M4 → M5.** The keepers will not strip the dish mount until the live listen passes. See [[Dish mount installation]].
- **M5.** Also carries the keeper chain: [[Echo sleep physiology]] sets [[Bunk shielding requirements]], which set the [[Bunk shielding spec]], which sits on the [[Refit schedule]]. A late bunk is a late M5 even if the dish is early.
- **M6.** The Disclosure Board approves what M1–M5 produced. It does not approve intentions.

## Critical path

The critical path runs M3 → M4 → M5. Float on M3 is eleven working days. Float on M4 is effectively zero, because the live listen needs a transmission at full operating power and **every transmission has been capped at power 0.30 since 4 March** (see [[Decision log]]). CAP-016 cannot reach M4 conditions while that cap stands. Nobody below the Director has a date for lifting it.

## Watch items, 1 June

1. **CAP-014 running, result pending.** Transmissions 201–800 go out at power 0.33, above the general cap, by Director's exception. Case Command has asked twice what makes this one safe. The answer on file is "per the echo model update (pending)".
2. **B-01** opened 28 May against Pellam build lot B7-L07. If the build is bad, M3 slips by the vendor's rebuild lead time. See [[B-01 Firmware 7 fault]].
3. **B-02** clock vendor delay threatens the flight relay clocks, not M4. See [[B-02 Clock vendor delay]].
4. **M1** depends on Echo model v2. Signals Lab says it is "nearly there". It has been nearly there since April.

> [!note] Saoirse
> If M3 slips, M4 slips, and M4 is the funding gate in the [[Case charter]]. I would like one week this summer where the critical path does not route through a capture I am not allowed to read page 3 of.
