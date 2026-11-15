---
owner: Xenobiology
status: running
depends_on: ["[[IR-0412 Tern-9 cryo alarm]]"]
tags: [mystery, frost, specimen]
---

# Frost feeding log

Frost specimen F-3. Recovered from the cold face of tile T-3, beside dish panel 7, after [[IR-0412 Tern-9 cryo alarm]]. Held in sealed cell SC-1 at 35 K on the receiver bay cold rack, behind the shield wall, about 4 m from the dish feed. Logged by Linnea; mass weighings by Bel Arkwright on the cryo microbalance. We call it a feeding log because the specimen gains mass and we do not know what it eats. Nothing goes into the cell.

![[frost-filament.svg]]

## Conditions

- Cell: sealed, evacuated, 35.0 K ± 0.2 K. Never opened since 10 April.
- Mass: differential weighing against an empty twin carrier. Resolution 0.1 µg.
- Tick rate: contact microphone on the cell wall; 10-minute average, no transmission in progress.
- Echo: the last logged echo before the entry. Logged power comes from the send summary.
- Raw power: peak transmit power from the raw timing-chain record, supplied by Mirela (Timekeepers) from 18 April onward, back-filled for earlier echoes. The send summary averages over 1 s; the raw record does not.

## Log

| Date | Mass (µg) | Cell T (K) | Ticks / min | Last echo | Logged p | Raw p (peak) | Note |
|---|---|---|---|---|---|---|---|
| 1 Apr* | 38.1 | 40.0 | — | 51 | 0.27 | 0.28 | *Reconstructed. No film visible yet (31 Mar fixture photos show none); mass inferred from tile T-3's mass excess at weigh-in |
| 3 Apr* | 39.6 | 40.0 | — | **52** | **0.29** | **0.36** (40 ms) | *Reconstructed. +4.0 % |
| 10 Apr | 41.2 | 35.1 | 0.8 | **53** | **0.24** | **0.33** (reconstructed) | +4.0 %. Echo 53 was the alarm-night soak, 9 Apr; the film became visible after it. Cell sealed. First direct weighing. |
| 14 Apr | 41.1 | 35.0 | 0.7 | 53 | 0.24 | 0.33 | No echo since; receiver bay held 9–14 Apr. No change. |
| 17 Apr | 41.1 | 35.0 | 0.7 | 55 | 0.28 | 0.29 | Live-listen test 04. No change. |
| 18 Apr | 42.3 | 35.0 | 1.9 | 58 | 0.30 | **0.33** (22 ms) | +2.9 %. Tick rate doubled in the 6 h after the echo. |
| 22 Apr | 42.3 | 35.0 | 0.9 | 60 | 0.26 | 0.27 | No change. |
| 26 Apr | 42.2 | 34.9 | 1.0 | 61 | 0.28 | 0.31 | No change. |
| 2 May | 43.9 | 35.0 | 2.4 | 63 | 0.29 | **0.34** (31 ms) | +4.0 %. |
| 9 May | 43.9 | 35.0 | 1.1 | 64 | 0.25 | 0.26 | No change. |
| 15 May | 43.9 | 35.1 | 1.2 | 66 | 0.30 | 0.32 | No change. Peak exactly 0.32. |
| 21 May | 45.5 | 35.0 | 2.6 | 67 | 0.29 | **0.35** (36 ms) | +3.6 %. |
| 27 May | 45.4 | 35.0 | 1.3 | 69 | 0.27 | 0.28 | No change. CAP-014 transmission blocks at p 0.25 run in between; no change after any of them. |
| 30 May | 46.6 | 35.0 | 2.2 | 70 | 0.28 | **0.33** (18 ms) | +2.6 %. |

![[frost-growth.svg]]

## Observations

1. **Mass rises only after echoes whose raw peak power exceeded 0.32.** Six of six such echoes (52, 53, 58, 63, 67, 70) were followed by a gain of 2.6–4.0 %. Seven of seven echoes with raw peak at or below 0.32 were followed by no change within the balance's resolution. Echo 66, peak exactly 0.32, did nothing. Echo 61, peak 0.31, did nothing.
2. **Every one of those echoes was logged at or below p 0.30.** The summaries are not wrong; they average. The excursions last 18–40 ms and are invisible at 1 s.
3. **The frost ticks before the echo arrives.** On every echo since 18 April with a raw excursion past 0.32 (58, 63, 67, 70), the cell microphone picks up a burst of ticks, and the filament mat visibly re-orients (cell camera, 120 fps), ahead of the echo reaching the receiver log. Lead times: 0.70, 0.72, 0.71, 0.71 s. On the echoes without an excursion it does nothing early, or at all. The receiver log and the cell camera share a timebase. I have checked the timebase four times. Mirela checked it once and then went very quiet.
4. **The ticking is regular.** Spectral analysis of the 21 May burst puts the tick envelope at 1.92 kHz. I note it without knowing whether it means anything.
5. **The mat is combed.** After each gain the new filament grows along the same axis, roughly radial to the dish feed, as if it were pointing at something.
6. **It did not spread at random.** Bel's 11 April map of where the film sat on tiles T-1 to T-6 is nine tidy spots on a grid, not a smear. The Annex has laid that map over their own rig sites in [[CAP-014 Air-gapped capture]]. I would rather they explained the grid than me.

## What I have not done

I have not fed it, warmed it or cut it. Every entry above is a measurement through a sealed window. Ayo wants it incinerated; Imani wants it in the clock loop; Petra wants us to ask whether either is ours to decide. I want the log to be clean enough that whoever decides can trust it.

## Note written back on 3 April entry, 30 May

When I reconstructed the tile weigh-ins I had a gain I could not place. Echo 52 was logged as a shallow, low-power echo, and a reply to message 52. Then Mirela's raw record arrived, and it showed a 40 ms spike to 0.36 that nobody had looked at, with no send command behind it. Message 52 had been pulled from the queue by the keeper on watch before it went.

Mass up 4 % after echo 52. Tern-9 never sent message 52. See [[Second timestamp]].
