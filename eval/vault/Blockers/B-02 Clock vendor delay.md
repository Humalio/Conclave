---
owner: Timekeepers
status: open
depends_on: ["[[Relay clock design]]", "[[Schedule]]"]
tags: [blocker, clock, vendor, m4]
---
# B-02 Clock vendor delay

Opened by Calder, 19 May 2191. Blocks: full-scale relay clock integration for M4 (live listen). Assigned: Timekeepers. Escalation: Saoirse.

## Summary

The new Tern-9 relay clock needs two cryogenic reference oscillators, one primary and one hot spare, per [[Relay clock design]]. The vendor has moved delivery from 9 June to 21 July, six weeks late. The bench clock on the Tern-9 test stand is a different build and cannot be put in service. Without the new oscillators, the [[Timing chain]] cannot be closed at full scale, and M4 cannot be scheduled with a real date.

## Cause

The vendor reports a failed acceptance batch: four of nine oscillators out of tolerance on aging rate at 4 K. They will not ship from the next batch until it has completed a 30-day aging soak. We asked whether they could ship two from the failed batch for test-stand use only. They said no, which is the answer we would have given.

## Impact

| Item | Before | After |
|---|---|---|
| Oscillator delivery | 9 Jun | 21 Jul |
| Relay clock assembled | 30 Jun | 11 Aug |
| Full-scale timing chain closed | 15 Jul | 25 Aug |
| M4 (due 30 Sep) | 10 weeks float | 5 weeks float |

M4 is not yet late. Its float is half what it was. [[Milestones]] and the [[Schedule]] have been told.

## Options

1. **Wait.** Costs five weeks of float. Recommended.
2. **Second source.** One other vendor qualified to the spec; 16-week lead. Worse than waiting.
3. **Put the bench clock in service.** Not possible: it was built to measure, not to run a relay eleven light-hours from a spare. It also has no hot spare.

## Notes

> [!note] Calder, 19 May
> When I explained what the oscillators are for, their applications engineer asked whether we really need every receive logged to 4 ns, given that, and I quote, "you seem to get two of them anyway". I have asked Case Command how a vendor came to know about echo 47. Case Command has asked me the same question.

> [!note] Mirela, 20 May
> The bench clock passed [[CAP-011 Clock holdover]] at < 0.3 ns. Whatever wrote the early entry on echo 47, the new clock will be built to the same design and will write it too, if it is there to be written. Delay changes the date, not the question.

## Next

Weekly call with the vendor, Thursdays. Decision on option 2 by 15 June if the 21 July date slips again.
