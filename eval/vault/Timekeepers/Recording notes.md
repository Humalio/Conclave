---
owner: Timekeepers
status: active
depends_on: ["[[Timing chain]]"]
tags: [timing, recording, echo-47, mystery]
---

# Recording notes

How to read the echo 47 sensor recording, what is in it, and what is not. Owner: Mirela, with Tobin. These notes accompany [[live-listen-03.bin]] and its sidecar [[live-listen-03.json]]. Echo 47 is live listen LL-03.

## The file

| Item | Value |
|---|---|
| File | live-listen-03.bin, about 400 KB |
| Sidecar | live-listen-03.json: channel names, units, scale factors, start time |
| Layout | Header, then little-endian float32 samples, channel-interleaved |
| Channels | 4: transmit power, receiver strain, dish temperature, clock phase |
| Sample rate | 5 kHz per channel |
| Window | 5.0 s, from 22:14:05.0, covering the early reply and the 3.0 s send |
| Clock | DAQ crate, disciplined to the relay clock within ±1 µs ([[Timing chain]]) |

Read the sidecar first. The header's start time is in Net time; the sidecar also gives it in relay-clock counts for anyone cross-checking against the TSU.

Inline readers stop at 90 000 bytes. The file is larger than that; download it whole before you analyse it.

## Channel notes

**Transmit power.** From the sample coupler. Power sits at zero until 07.000, then climbs to 0.34 and stays there for 3.0 s. The PA drive current, recorded separately by the amplifier controller (see [[Listening log]]), holds the 0.25 profile, flat, through the whole send. Nothing in the drive accounts for the extra power.

**Receiver strain.** From the gauge on the cold fixture backing plate, under receiver cell RC-3's row. During the send the spectrum shows the PA drive lines below 400 Hz, as expected, and **a narrow line at 1.92 kHz that nobody modelled**. The [[Timestamp fault model]] has no term for it. The line is absent in the first two seconds of the file, before the send, and in every lower-power recording since strain went to 5 kHz on 1 March.

**Dish temperature.** Fixture cold face. Rises 0.6 K during the send, consistent with PA heating. Unremarkable, which in this file is remarkable.

**Clock phase.** Phase of CL-A against the run reference. Flat to within the jitter measured in [[Holdover test]]. No step, no slip, nothing at 06.290. The clock did not stumble; it recorded.

## What is not in this file

**The dish-house microphone.** It runs on a separate audio interface at 48 kHz and is archived with the transcript audio, not here. Its relevant property, for this note, is its timing: the microphone records a dry, irregular ticking that begins **0.71 s before the clock stamps the reply**. The microphone is 30 cm from the cold fixture. Its clock is synchronised by a tone at the start of the window, independent of the DAQ crate. See [[Tern-9 transcript, echo 47]] for what the keeper was saying while it ticked.

**The TSU event stamps.** In the relay clock's own log. The early "reply detected" stamp at 22:14:06.290 is there, not here.

**Page 3 of the live-listen record.** Withheld. See [[CAP-016 Live listen]].

## Handling

- Do not resample the strain channel below 4 kHz; you will alias the 1.92 kHz line away and then wonder where it went.
- Do not summarise power with a 1 s average. That is how echo 52 was misread.
- Cite channel and time window when you quote a value.

## For the analyst

If you put the strain spectrogram, the microphone envelope and the TSU stamps on one time axis, three independent instruments line up on the same moment: 0.71 s before the dish does what they are reacting to.

We have done it. Tobin printed it and pinned it over his desk. It is in [[Second timestamp]].
