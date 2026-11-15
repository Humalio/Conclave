---
owner: The Annex
status: closed
depends_on: ["[[Firmware 7]]", "[[Timestamp fault model]]", "[[Shielding interface]]"]
tags: [reviews, shielding, firmware-7]
---

# Shielding review

Interim review RV-11 of the receiver shielding and the Firmware 7 explanation, with CAP-014 at about 130 of 800 transmissions. Held 12 May 2191, by link from Corvel to Tern-9. Chair: Brannoc (Relay Engineering, independent of the Annex). Presenter: Hesper. Reviewers: Lusa, Kemi, Hollis (Disclosure Board). Minutes by Quentin.

## Evidence presented

- [[CAP-012 Baseline listen]]: every reply stamped correctly below power 0.30, four receivers, no anomalies.
- [[CAP-014 Air-gapped capture]]: about 130 / 800 transmissions at power 0.25, firmware removed, ORRIN disconnected. No echo, as expected below the threshold.
- [[CAP-014b Empty dish]]: started 6 May on the scraped dish, one block ahead; about 90 transmissions, no echo.
- [[Timestamp fault model]]: predicted mis-stamp rate at operating power 1 in 3,700 transmissions, clock path only.
- Build 7 front-end response, lot B7-L07: gain peak at 2.2–2.4 GHz.
- Q-9 front-end response, candidate: shielded outside the 2.3 GHz band. Shown as backup.

## Findings

| # | Grade | Finding |
|---|---|---|
| F-1 | **Major** | No capture evidence exists above power 0.30. R4 requires 600 transmissions at operating power. Transmissions 201–800 at 0.33 are the only planned evidence above the cap and depend on an echo model update not yet issued. |
| F-2 | Minor | The timestamp fault model covers the clock path only. The receiver strain channel on echo 47 shows content at 2.3 GHz. The Annex to state whether it is significant. |
| F-3 | Minor | Dish panels near panel 7 show a fine glassy residue. Section two samples and report. |
| F-4 | Observation | The two front-end curves were presented on the same slide, with build 7's peak and Q-9's shielded band sitting on the same 2.3 GHz. Nobody remarked on it. Recorded at the chair's request. |

## Discussion

Hesper argued that power 0.33 is close enough to show the trend. Hollis asked why 0.33 and not 0.32 or 0.35; Hesper said it was the power Signals Lab recommended. Kemi asked whether the cap would be lifted for the 201 block; Brannoc said the exception for 0.33 was already signed: D-009, 20 April. Kemi asked on what grounds. Brannoc said the decision log does not give a reason, and that he had read it twice to be sure.

Lusa asked whether CAP-014b was needed at all, given the cost of scraping a live dish. Ayo, attending as an observer, said it was needed precisely because nobody could yet say what was growing on the face.

## Outcome

Continue. F-1 carried to M3. F-2 and F-3 to the Annex by 31 May (F-3 delivered; F-2 outstanding).

## Note

F-4 was added to the minutes after the meeting, at Brannoc's request, by message. His message reads, in full: "Put the 2.3 thing in. I don't know why. Just put it in."
