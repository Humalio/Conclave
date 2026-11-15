---
owner: Xenobiology
status: active
depends_on: ["[[Echo sleep physiology]]", "[[Lead time vs transmit power]]"]
tags: [keepers, echo-sleep, model]
---

# Dose model

How Xenobiology predicts echo-sleep dose. Owner: Linnea. Fitted 2 April 2191; refitted 19 May with two additional volunteers.

## Model

Dose in EH for one live listen:

> D = k · p² · t · B · S

| Symbol | Meaning | Value |
|---|---|---|
| p | Transmit power (relative, 0–1) | Planned live listen: 0.62 |
| t | Time on air (s) | Planned live listen: 11 s |
| B | Bunk factor | 1.0 reclined in a shielded bunk; 1.4 open sleeping place |
| S | Individual sensitivity | 1.0 median; 0.7–1.5 across volunteers |
| k | Fitted constant | 0.497 EH / s |

Power follows feed current roughly as its square (see [[Lead time vs transmit power]]), so dose goes roughly as the fourth power of current. A 5 % current overshoot is a 22 % dose overshoot. Relay Engineering have been told this, twice.

## Prediction for the planned live listen

| Case | p | t (s) | B | S | Dose (EH) |
|---|---|---|---|---|---|
| Median keeper, shielded bunk | 0.62 | 11 | 1.0 | 1.0 | **2.1** |
| Median keeper, open sleeping place | 0.62 | 11 | 1.4 | 1.0 | 2.9 |
| Sensitive keeper (90th pct), shielded bunk | 0.62 | 11 | 1.0 | 1.3 | 2.7 |
| Median keeper, p overshoot to 0.64 (shutdown threshold) | 0.64 | 11 | 1.0 | 1.0 | 2.2 |
| Median keeper, two listens in 30 days + one corrective each way | — | — | 1.0 | 1.0 | 8.4 |

All cases fall within the [[Exposure limit]] (3 EH per exposure, 9 EH per 30 days), but the sensitive-keeper case leaves 0.3 EH of margin, which is less than I would like.

## Fit quality

- 16 volunteers, 61 exposures, p 0.10–0.30, t 2–8 s.
- Residuals: ±18 % (1σ). No trend with power over the fitted range.
- Extrapolation from p 0.30 to p 0.62 is a factor of 4.3 in p². **The model has never been tested in the regime where it will be used.**

## Known gaps

1. No data above p 0.30.
2. No data for t > 8 s.
3. One outlier excluded: a volunteer exposure during echo 52 (logged p 0.29) gave a dose 31 % above prediction. The exposure was flagged "subject moved head" and dropped. On review of the annex video, I am no longer certain the subject moved. Kept in an appendix, not in the fit.
