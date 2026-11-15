---
owner: Relay Engineering
status: redacted
depends_on: ["[[CAP-016 Live listen]]", "[[Tern-9 transcript, echo 47]]"]
tags: [echo-47, ll-03, mystery, receiver-bay]
---
# Echo 47 (why we stopped)

Written by Lusa, who was at the console. Reviewed by Brannoc. This note exists because people keep asking in the corridor, and the corridor is not a record.

## What was planned

Transmission 47 was **LL-03**, the third subscale live listen in [[CAP-016 Live listen]]: the 1:20 subscale dish on the test stand in receiver bay 2, full charge sequence, hold, commanded send, listen. Planned power **p 0.25**, hold 3.0 s, send at 22:14:07.000 on 3 March 2191. LL-01 and LL-02 had gone to 0.20 and 0.23 without a mark on them. LL-03 was the step before the step. The first forty-six logged echoes had been filed as clock noise. This was the forty-seventh.

Keepers: Lusa on console, Teodor on the relay clock, Bel Arkwright in the cryo bay watching the cold fixture. Recording: [[live-listen-03.bin]], all four channels.

## What happened

| Time (3 Mar) | Event |
|---|---|
| 22:14:04.0 | Power readback **0.34**. Profile says 0.25 |
| 22:14:05.58 | Bay microphone picks up a dry ticking at the cold face, panel side |
| 22:14:06.290 | Relay clock logs a reply. 0.71 s after the ticking started |
| 22:14:07.000 | Send commanded, and the reply logged again |
| 22:14:07.0 | Power back to zero. 3.0 s at 0.34 |
| 22:14:07.4 | Bay intercom loses power |

The dish went to 0.34 and held there for three seconds. The feed current trace has not been reconciled with that number; see the redaction below.

The clock wrote the reply down twice. The second entry is the one our send command triggered. The first is **0.71 s earlier**, before anyone had touched anything. The Timekeepers call it the [[Second timestamp]], meaning the one that should not be there, which is confusingly the first one.

The strain channel on the cold fixture shows a narrow line at **1.92 kHz**, starting at the first entry and gone by the second. Nobody modelled anything at 1.92 kHz; the [[Timestamp fault model]] stops at 400 Hz.

The intercom dropped 0.4 s after the send. The fixture was undamaged, the feed modules did not surge, the bank discharged normally. What we have of the voices is in [[Tern-9 transcript, echo 47]], which stops in the middle of Teodor's sentence.

## What the receive log says

█████ █████████ ███ ████ ██████ ████ ███████ ██ ████ ████ █████ █████████ ███ ██████ ███ ████ ███████ ███ █████ █████ ███████ ███ █████ ██ ████ ███ ███████ ████ ███ ███████ ███████ ██ ████ ████████ ███ ██████ █████ ███ ████ ██████ ███ ███████ █████████ ████[^1]

## Why we stopped

The next morning, 4 March, the director's office issued the stop order. What we were told:

1. No transmission above power 0.30. Interlocks set by noon.
2. LL-05 postponed, no date.
3. The LL-03 page withdrawn from the shared live-listen log.

What we were not told is why it went that far. A power overshoot of 0.09 on a subscale bench is a controller ticket, not a campaign pause. Brannoc asked. The answer was that the order stands.

## What we still don't know

- Why the power readback says 0.34 when the profile said 0.25.
- What the clock saw at 22:14:06.290. Teodor says jitter. [[CAP-011 Clock holdover]] says the clock does not jitter by 0.71 s, or by anything close.
- What was ticking. Bel says it came from the cold face, the side with dish panel 7. Nobody has asked her since.
- Why the intercom.

Echo 52 on 2 April was logged at p 0.29, under the cap. The Timekeepers pulled the raw timing chain for it anyway.

They found something. See [[Second timestamp]].

[^1]: Redacted under [[Do not circulate - echo 47]].
