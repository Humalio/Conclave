---
owner: Timekeepers
status: closed
depends_on: ["[[Relay clock design]]", "[[Timing chain]]"]
tags: [clock, holdover, jitter, echo-47]
---
# CAP-011 Clock holdover

Capture lead: Mirela. Analysis: Tobin. Signed off: Calder. Tern-9 test stand timing rack, 17–21 March 2191. Full test write-up: [[Holdover test]].

## Purpose

Two questions, one rig.

1. Does the relay clock hold the send timing within 4 ns (R5) when its reference is lost for the length of a transmission? This was always on the plan.
2. Can clock jitter produce a reply logged 0.71 s before the send command, as on echo 47? This was added on 12 March, after [[Lab notebook — Teodor]] proposed it, and after several people asked us to settle it rather than argue about it in the canteen.

## Method

The bench relay clock, in the rack that drove echo 47, with the same firmware (build 7) and the same cable runs per [[Timing chain]]. The receiver front-end coax and the test-stand DAQ crate had both been replaced on 15 March, before the test. Disciplined to the stand reference, then the reference was cut and the clock left in holdover for 72 h. PC-A and PC-B phase against an independent laboratory reference was compared every 10 µs. During the last 6 h, 1 000 synthetic send edges were fired into both TSU inputs, and the logged time of each was compared with the time it was fired. The rack ran at 20 °C, with one stretch of cooling throttled to 31 °C. Data: [[clock-drift.csv]].

## Result

| Quantity | Measured | Requirement |
|---|---|---|
| Jitter (white residual, RMS) | 0.27 ns | — |
| Jitter (peak, whole test) | < 0.3 ns at 20 °C; 0.29 ns at 31 °C | — |
| Frequency offset in holdover | 0.050 ns/s | Feeds [[Clock drift model]] |
| Drift over an 11 s transmission window | 0.55 ns | ≤ 4 ns (R5) |
| Edges logged before they were fired | 0 of 1 000 | — |
| Edges logged twice | 0 of 1 000 | — |

R5 is met with margin. The clock is quiet.

## On jitter as a cause of echo 47

Jitter is below 0.3 ns. The echo 47 anomaly is 0.71 s. To jitter by 0.71 s, the clock would have to be wrong by about 2.4 billion times its worst measured error, once, and then exactly right again 0.71 s later when it logged the real send command.

Jitter is ruled out as the cause of a 0.71 s anomaly.

> [!note] Calder, 21 March
> For the record, we also checked that the clock was not simply set 0.71 s fast. It wasn't. It logged the send command at 22:14:07.000, on time. It logged a reply before it, as well. A clock that is early is a problem we know how to fix. A clock that is right twice is not.

## What this does not explain

Something wrote an entry into the clock log at 22:14:06.290 on 3 March. It was not jitter, not drift, and not a duplicate of the command. The log entry has the format of a reply detected on the timing chain's receive input, which listens to the dish, not to the console.

The receive input reported a reply 0.71 s before the send. Either that input was wrong, or it was not wrong. We have filed this under [[Second timestamp]], and Teodor's notebook has not been updated since.
