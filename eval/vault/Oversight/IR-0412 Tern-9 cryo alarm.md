---
owner: Disclosure Board
status: open
depends_on: ["[[Cryo plant]]", "[[Timing chain]]"]
tags: [incident, frost, mystery]
---

# IR-0412 Tern-9 cryo alarm

**Incident report IR-0412.** Tern-9, receiver bay 2. Wednesday 9 April 2191, 03:40. Classification: cryogenic pressure transient, no injury, no release. Investigating officer: Hollis (Disclosure Board). Report issued 16 April; reopened 23 April.

## Summary

At 03:40 a pressure transient in the receiver bay cold fixture raised alarm CR2-P-04. The relief valve lifted once and reseated. The night keeper, Bel Arkwright, responded and, during the post-alarm borescope inspection, found an unrecorded glassy film on the cold receiver face, tile T-3, beside dish panel 7. The film was removed under quarantine on 10 April. It is now catalogued as frost specimen F-3 and kept at 35 K (see [[Frost feeding log]]).

## Timeline

All times from the alarm panel and the receiver bay data logger. The data logger is disciplined to the Tern-9 [[Timing chain]] master. The alarm panel runs on the plant controller clock, which is synced to the timing chain to ±5 ms; the sync was verified within that band on 10 April. A 0.7 s discrepancy is far outside it.

| Time | Source | Event |
|---|---|---|
| 03:38:20.000 | Feed controller | Echo 53 transmission start. Night thermal-soak, commanded power 0.24. Automated; no keeper in the bay. |
| 03:39:50.000 | Feed controller | Hold at commanded power. |
| 03:40:11.300 | **Alarm panel** | **CR2-P-04 "Cryo pressure high" raised.** |
| 03:40:11.940 | Feed controller | End of transmission commanded (end of soak). |
| 03:40:12.000 | Pressure sensor PT-04 | **Transient registered: 1.82 bar → 2.61 bar.** Alarm threshold 2.40 bar. |
| 03:40:14.200 | Relief valve RV-2 | Lift; reseat at 03:40:15.900. |
| 03:41:05 | Access log | B. Arkwright badge at the bay viewport. |
| 03:52 | Data logger | Cold fixture back at 40.1 K. |
| 04:20 | B. Arkwright | Borescope inspection through port IP-2. Film observed on tile T-3. |
| 06:10 | Duty log | Hesper (The Annex) notified. |
| 07:05 | Duty log | Ayo (Xenobiology) notified; quarantine requested. |

> [!note] Investigator's note
> The alarm CR2-P-04 has exactly one input: PT-04 above 2.40 bar. It is logged **0.7 s before** the sensor that caused it. The alarm panel was bench-tested on 11, 14 and 15 April with injected PT-04 signals; latency was 3–5 ms after the sensor every time. No fault was found. — Hollis

## Statement of B. Arkwright

> I was doing the 03:30 boil-off round. The soak was running, nothing unusual on the board. I was standing at the receiver bay cryostat with my hand on the housing, checking the frost line, and I felt it before I heard it. A dry ticking, very fast, like a fingernail tapping a frozen window. Then the alarm. Then the valve. I want to be clear about the order because the panel says something different and people keep asking me: ticking, alarm, valve.
>
> After the cold fixture settled I put the borescope in through IP-2. Five tiles looked the way they always look, grey and matte. T-3 had a skin on it. It caught the light like wet glass, but nothing is wet at 40 K. Up close it was threads, very fine, lying in a pattern, as if somebody had combed it. I took twenty-two frames and called it in.
>
> I did not touch anything. I would like that written down.

## Findings

Finding 1. A film approx. 11 mm × 6 mm covered the cold face of tile T-3. Under the borescope it resolved into a mat of glassy filaments a few microns wide.

Finding 2. The film was not present in the fixture inspection photographs of 31 March.

Finding 3. No film visible to the eye on T-1, T-2, T-4, T-5 or T-6. Micro-pitting was noted on all six tiles; its relation to the film is not established.

Finding 3a (11 April). Under the microscope, Bel Arkwright mapped faint film at nine spots across all six tiles, T-1 to T-6. The film on T-3 is the thickest by far.

Finding 4. Tile T-3 sits directly against dish panel 7, fitted in the 2189 refit. The panel's history is in [[Dish panel 7 (the one nobody ordered)]].

Finding 5. The pressure transient is consistent with a brief heat load on the cold fixture. Its source is not identified.

Finding 6. The sequence of alarm and sensor cannot be explained by any known fault in the alarm panel or the timing chain.

## Actions

A-1. The specimen shall be held sealed at 35 K and shall not be opened outside a Xenobiology-approved cell. (Xenobiology; done 10 Apr.)

A-2. The Timekeepers shall supply the raw timing-chain record for echo 53. (Open. A reconstruction from the 1 kHz chain puts the raw peak at power 0.33, against 0.24 commanded.)

A-3. The Disclosure Board shall enter a hazard for unidentified biological material. (Done 23 Apr: H-12 in the [[Hazard log]].)

A-4. Tern-9 Keepers shall supply the history of dish panel 7. (Done; see the panel note.)

The panel has been tested three times since. It has never again fired before its sensor. It has also never again been cold with frost on tile T-3.
