---
owner: Signals Lab
status: open
depends_on: []
tags: [signals, notebook, mystery, echo-47]
---

# Lab notebook — Imani

Signals Lab bench notebook, Imani. Margin notes kept in place (marked *margin*). Attached to the 14 March review pack at my request, as the dissent to [[Lab notebook — Teodor]].

## 5–7 March

**5 Mar.** Echo 47 relay clock log, two records:

| Input | Event | Time |
|---|---|---|
| Sequencer (commanded) | SEND CMD | 22:14:07.000 |
| Reply detector | REPLY DET | 22:14:06.290 |

DET before CMD by 0.710 s. The detector cannot see a reply to a message that has not been sent. Either the detector is wrong, or the clock is wrong, or something the detector can see arrived 0.71 s early.

*margin:* T. says "jitter". Jitter is noise around a true time. This is not noise. It is one clean edge, in the wrong place.

**6 Mar.** Dish-house microphone track. Dry ticking, irregular, maybe 6–10 per second. Starts 0.71 s before the clock stamps the reply. Stops within a second of the send ending. Listened to the recordings of CS-31, CS-39 and CS-44 for comparison: hiss and cryo creak only. No ticks.

*margin:* I keep checking this. Same lead, different instrument, different crate input, different sample clock.

**7 Mar.** Teodor wrote "nothing odd" in the status report. I did not get to see it before it went.

## 10–12 March

**10 Mar.** Receiver strain on the cold fixture, echo 47 (from [[live-listen-03.bin]]). A narrow spectral line at 1.92 kHz, present during the high-power send only. The mount model covers 40 to 400 Hz. Nothing in the PA drive is near 1.92 kHz.

Then the ring-down tail. After the send, the slow stage has an oscillating residue. Period 0.52 ms. I did the division three times. 1.92 kHz.

**11 Mar.** Went back through every calibration sweep with a raw record, CS-1 to CS-46. Looked for: second timestamp, ticking, 1.92 kHz. The 46 echoes filed as clock noise cannot be checked this way: no raw power record was kept for any of them.

| Power band | Sweeps | Second timestamp | Ticking | 1.92 kHz |
|---|---|---|---|---|
| ≤ 0.25 | 41 | 0 | 0 | n/a (2 kHz strain sampling) |
| 0.25 – 0.30 | 5 | 0 | 0 | n/a (2 kHz strain sampling) |
| 0.34 | 1 (echo 47) | yes | yes | yes |

**Nothing odd below 0.31.** I have no data between 0.31 and 0.33. Call the threshold 0.32 until someone gives me a transmission in between.

*margin:* A threshold in transmit power is not how cables fail.

*margin:* Strain was sampled at 2 kHz until 1 March. Nothing before echo 47 could have seen a 1.92 kHz line even if it was there. I keep checking this.

**12 Mar.** Dissent for the review pack. Jitter cannot put the same 0.71 s into a clock channel and a microphone on different sample clocks, and it cannot produce a spectral line. Nor will I accept that ORRIN is putting it there: ORRIN does not write the microphone track. I do not know what this is. I know what it is not.

## After the review

**21 Mar.** [[CAP-011 Clock holdover]]: jitter < 0.3 ns. Calder sent me the result before he sent it to Teodor. I appreciated that more than I said.

**2 Apr.** Echo 52, message 52 queued at P 0.29. Summary log: 0.29, very tidy. Mirela pulled the raw timing chain: a 40 ms spike to 0.36, which a 1 s summary average flattens into nothing. Nobody commanded it. Above my line.

**9 Apr.** Night alarm in the dish house. Bel Arkwright found a glassy film on receiver cell RC-3. It ticks when it is cold. The ticks on echo 47 were never the cryostat.

*margin:* The microphone is 30 cm from the fixture. The fixture holds the frost.

**20 Apr.** CAP-014 schedule published. Transmissions 401–1000 at P 0.33. I asked Orla who chose 0.33. She said the director. I asked why it was above my line. She did not answer, and then she said, quietly, that it was a good question.

**22 Apr.** Petra and I sent the ethics question together. If it hears what we cannot, we should at least ask what we are doing to it.

**30 May.** Xenobiology's feeding log says the frost gains mass after high-power events and not after low-power ones. It gained after echo 52, the message that never went past 0.3 on paper.

It is counting the echoes the summaries leave out. [[Frost feeding log]]
