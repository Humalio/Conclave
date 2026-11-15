---
owner: Signals Lab
status: open
depends_on: ["[[Echo model v1]]"]
tags: [signals, mystery, open]
---

# Open questions

What Signals Lab does not know, written down so that we stop pretending we do. Started by Orla on 14 March, the afternoon of the review with the whiteboard. Anyone in the case may add a question. Nobody may delete one; close it with a link to the answer.

## Open

| # | Question | Raised | By | Where the data is |
|---|---|---|---|---|
| OQ-1 | Why did the relay clock log a reply at 22:14:06.290 on echo 47, 0.71 s before the commanded send at 22:14:07.000? | 5 Mar | Imani | [[Second timestamp]] |
| OQ-2 | Why does the dish-house microphone record a dry ticking that starts 0.71 s before the clock stamps the reply on echo 47? | 6 Mar | Imani | [[Recording notes]], [[Tern-9 transcript, echo 47]] |
| OQ-3 | What excites a line at 1.92 kHz in the receiver strain channel? Neither the echo model (≤ 400 Hz) nor the [[Timestamp fault model]] has anything there. | 10 Mar | Imani | [[live-listen-03.bin]] |
| OQ-4 | The slow ring-down stage on echo 47 carries an oscillating residue with a 0.52 ms period. That is 1.92 kHz. Coincidence? | 10 Mar | Imani | [[Echo decay]] |
| OQ-5 | Is there a power threshold? No anomaly on any transmission at or below P 0.30; anomalies on every one that went past 0.33. | 12 Mar | Imani | [[Lab notebook — Imani]] |
| OQ-6 | Message 52 was queued at P 0.29, summarised at 0.29 and never sent. The raw timing chain shows 40 ms at 0.36. Where did 0.07 of power come from, for 40 ms, with no send command? | 3 Apr | Mirela | [[Second timestamp]] |
| OQ-7 | Arden saw an early transient in 2179 and withdrew it as a cable reflection. Were the re-runs strong enough to see it again? | 17 Mar | Imani | [[Literature - Arden 2179 on early replies]] |
| OQ-8 | What is the frost responding to? Its activity appears to lead the echo by the same 0.71 s. | 15 Apr | Orla | [[Frost feeding log]] |
| OQ-9 | Why is CAP-014's second block at P 0.33, above the 4 March cap, "per the echo model update (pending)", when the update depends on CAP-014? | 21 Apr | Sef | [[Echo model v1]], [[Decision log]] |

## Closed

| # | Question | Closed | Answer |
|---|---|---|---|
| OQ-0 | Is clock jitter large enough to explain OQ-1? | 21 Mar | No. [[CAP-011 Clock holdover]]: jitter < 0.3 ns. The anomaly is 0.71 s. See [[Holdover test]]. |

Teodor asked for OQ-0 to be marked "closed, cause unconfirmed" rather than "closed, no". The answer column records what CAP-011 measured, not what anyone hoped.

## Patterns

Four numbers keep turning up in independent instruments:

- **0.71 s.** In the clock (OQ-1), the microphone (OQ-2), the frost activity (OQ-8), and the alarm log for [[IR-0412 Tern-9 cryo alarm]], where an entry precedes the sensor that triggered it by 0.7 s.
- **1.92 kHz.** In strain (OQ-3) and in the ring-down residue (OQ-4).
- **P ≈ 0.32.** Below it, nothing (OQ-5). Above it, all of the above.
- **2.3 GHz.** The band where the receiver rings. The [[Timestamp fault model]] has no term for it.

Signals Lab's position, agreed 14 March and reaffirmed 30 May: these are real observations in calibrated instruments; no single instrument fault explains all of them; the echo model has no mechanism for any of them.

## What we are not allowed to do about it

The obvious experiment is a controlled transmission at P 0.34 with every instrument recording raw at full rate. The cap of 4 March forbids it, for reasons recorded in the [[Decision log]] as redacted.

The only planned exposure above P 0.32 is [[CAP-014 Air-gapped capture]] from transmission 401. Its receiver is a hand-clocked front end with no ORRIN in the loop. It has no microphone and no raw timing capture.

> [!note] Orla
> Imani asked in the 14 March review who could tell us why the cap was set. Somebody wrote "ask the director" on the whiteboard and somebody else crossed it out. Neither of them has owned up. [[Whiteboard, 14 March]].
