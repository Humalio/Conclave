---
owner: Timekeepers
status: closed
depends_on: ["[[CAP-011 Clock holdover]]", "[[Relay clock design]]"]
tags: [timing, jitter, echo-47]
---

# Holdover test

Timekeepers' analysis of [[CAP-011 Clock holdover]], run 17–21 March 2191 on the engineering relay clock. Author: Calder. The capture record holds the raw procedure; this note holds what it means.

## Why we ran it

On 12 March, Signals Lab attributed the echo 47 double timestamp to "clock jitter (broad sense: timing-chain fault)" ([[Lab notebook — Teodor]]). Timekeepers own the clock and were not prepared to accept a diagnosis of their own instrument without measuring it. Calder offered the test on 11 March; Teodor accepted it on the grounds that it "will show the clock is not perfect". It did. Not in the way he meant.

## What we measured

The engineering clock was cut off from its reference and run free for 72 hours, with CL-A and CL-B each compared against a laboratory reference oscillator. Every 10 µs we recorded both clocks' offsets. During the last 6 hours we fired 1 000 synthetic reply edges into both TSU inputs simultaneously, through the full cable runs, including the receive coax replaced on 15 March.

## Result

| Quantity | Measured | Requirement or comparison |
|---|---|---|
| Jitter (white residual, RMS) | **0.27 ns** | < 0.3 ns |
| Frequency offset | 0.050 ns/s | Feeds [[Clock drift model]] |
| Drift over an 11 s send window | 0.55 ns | ≤ 4 ns (R5) |
| CL-A vs CL-B disagreement, max | 0.11 ns | Fault flag at 0.5 ns |
| TSU input A vs B on simultaneous edges, max | 0.4 ns | Calibrated path difference removed |
| Edges stamped out of order | 0 of 1 000 | — |
| Duplicate stamps | 0 of 1 000 | — |
| Edges stamped early | 0 of 1 000 | — |

The data is in [[clock-drift.csv]].

## Conclusion

**Jitter is ruled out as the cause of the echo 47 second timestamp.**

The measured jitter is under 0.3 ns. The anomaly is 0.71 s. The ratio is about 2.4 × 10⁹. If jitter of this clock were to produce a 0.71 s error even once, it would need to be a fluctuation so large that it would not occur in the lifetime of the universe, the case or Teodor's patience, in roughly that order.

The broader claim, "timing-chain fault", is also unsupported. In 1 000 synthetic edges the chain never stamped out of order, never duplicated, and never stamped early. The receive cable had been replaced. The DAQ crate had been swapped. The TSU firmware was checked byte for byte against the release image.

## What the test does not say

The holdover test says the clock was not wrong. It does not say what the clock was right about.

If input B's 06.290 stamp is a faithful record, then the receiver saw something at 22:14:06.290 with the signature it normally sees when a reply lands. The test cannot tell us what that was. Timekeepers' position since 21 March: the clock recorded a real event at a real time; the event was not a reply to anything we sent; it looked like one.

The engineering clock runs the build 6 image; Tern-9 itself runs build 7. The Authority has noted that the test therefore says nothing about [[Firmware 7]]. That is true, and it is the only comfort in this note.

## Effect on other notes

- Case risk CR-00a closed ([[Risk register]]).
- Decision D-007 records jitter closed as a cause ([[Decision log]]).
- [[Open questions]] OQ-0 closed; OQ-1 stays open.

> [!note] Calder
> We set out to prove our clock innocent and succeeded, which leaves us holding a perfectly reliable record of something impossible. Continued in [[Second timestamp]].
