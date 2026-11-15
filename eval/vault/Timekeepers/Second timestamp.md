---
owner: Timekeepers
status: open
depends_on: ["[[Timing chain]]", "[[Holdover test]]", "[[CAP-011 Clock holdover]]"]
tags: [timing, mystery, echo-47, echo-52, frost]
---

# Second timestamp

Timekeepers' working file on the echo 47 clock anomaly and what has followed it. Authors: Mirela and Calder. Opened 5 March 2191. Status: open. Everything here is observation. Nothing here is explanation, because we do not have one.

![[timing-chain.svg]]

## Echo 47: the clock logs the reply twice

Echo 47 was live listen LL-03 in the dish house at Tern-9, 3 March. Planned power 0.25. The PA drive stayed on the 0.25 profile; the coupler read 0.34 anyway, and held there for 3.0 s from the commanded send. The relay clock's timestamp unit has two independent inputs ([[Timing chain]]): A, the sequencer's command; B, the receiver. On every other record B fires 412 µs after A, because the loopback tone takes that long through the filter chain. On echo 47:

```
TSU LOG  LL-03 / ECHO 047                    Net time
22:14:06.290 000 3  IN-B  REPLY DET   frame 9C41  edge OK
22:14:07.000 000 0  IN-A  SEND CMD    seq 4471    edge OK
22:14:07.000 412 7  IN-B  LOOP DET    tone OK
22:14:07.000 931 2  IN-B  REPLY DET   frame 9C41  edge OK
```

Four lines. The middle two are an ordinary send with an ordinary 412 µs gap. The last is the reply as the receiver delivered it, on arrival. The first is the second timestamp: the same reply frame, hash and all, stamped by a clean edge with the correct threshold and shape at **22:14:06.290**, which is **0.71 s before** the send command existed.

The dish did not radiate at 06.290. PA drive was zero and coupler power flat until 07.000; the [[Recording notes]] confirm it. Whatever input B saw, it looked like a reply to a message nobody had sent yet.

## Not jitter

Signals Lab called it clock jitter ([[Lab notebook — Teodor]]). On 21 March, [[CAP-011 Clock holdover]] measured the clock's jitter at under 0.3 ns, and 1 000 synthetic edges through the same chain produced no early, duplicate or out-of-order stamps ([[Holdover test]]). A 0.71 s error is about 2.4 billion times the jitter. The cable had been replaced; the crate had been swapped. **Jitter is ruled out.** The clock is not lying. It is reporting.

## Echo 52: the spike the average ate

Echo 52, 2 April. Message 52 was queued at P 0.29, under the cap, and the PA held on the pre-ramp profile while the keeper confirmed. The summary log, a 1 s average, reads 0.29 for every second of the hold. On 3 April Mirela opened the raw 1 kHz power record from input B and found 40 consecutive samples at **P 0.36**, a 40 ms spike under a steady queue. The 1 s average moves by less than three thousandths and the summary rounds it away.

Forty milliseconds at 0.36 is above Imani's line (nothing odd below 0.31; see [[Lab notebook — Imani]]). Nothing commanded it. The amplifier log shows nothing. The drive current, by the DAQ crate, shows nothing. Only the receiver saw it, which means either the dish radiated 0.36 without a send, or the receiver saw something that reads as power and is not made by the amplifier.

Echo 52 has no capture record of its own, so under R11 the spike cannot be cited in the disclosure case. It is cited here.

## The microphone

The dish-house microphone is on a separate audio interface with its own clock, 30 cm from the cold fixture. On echo 47 it records a dry, irregular ticking that begins **0.71 s before the clock stamps the reply**, and ends within a second of the send ending. On calibration sweeps: hiss and cryo creak, nothing else. The people in the room heard it. Read what the keeper said in [[Tern-9 transcript, echo 47]]; the transcript stops mid-sentence.

On 9 April a night technician found the source of the ticking on receiver cell RC-3. It is alive, it ticks below 60 K, and since 10 April Xenobiology has been weighing it. Its activity leads the echo by the same 0.71 s.

## Same lead, independent instruments

| Instrument | Clock | What it recorded | Lead |
|---|---|---|---|
| Relay clock, input B | 10 MHz relay clock | Reply frame, echo 47 | 0.71 s |
| Dish-house microphone | 48 kHz audio | Ticking onset, echo 47 | 0.71 s |
| Cryo alarm log | Plant controller | Alarm entry before its trigger, 9 Apr | 0.7 s |
| Frost specimen F-3 | — | Activity ahead of the echo | ≈ 0.7 s |

Four clocks. No shared hardware between any pair. One lead.

## What we don't know

1. What input B detected at 22:14:06.290.
2. Why the lead is 0.71 s at P 0.34 and, as far as we can tell, the same at P 0.36.
3. Whether there is anything below P 0.32 at all, or only nothing we can see.
4. What a second timestamp at P 0.62 would mean for our fix ([[Lead-time error]]).
5. Why the campaign was paused the day after echo 47. The live-listen record cites a memo, [[Do not circulate - echo 47]]. The link does not open for Timekeepers. We have asked.

The paused campaign is told from the test stand's side in [[Echo 47 (why we stopped)]]. The specimen is told from the other side.

## The last entry

Xenobiology's latest entry, 30 May, in [[Frost feeding log]]: mass up 4 % after echo 52. On paper, echo 52 never went past P 0.3. The frost gained weight on the 40 ms the summary threw away.

Then Mirela went back to the send log for message 52, to line the frost's gain up against the send command. There is no send command. The queue shows 52 pending at 0.29, then cancelled at the keeper's prompt, unsent. The log holds a reply to it, stamped, with a frame hash. Calder checked the hash against every message Tern-9 has ever transmitted.

It matches none. He has started on the drafts folder.
