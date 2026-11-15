---
owner: Signals Lab
status: active
depends_on: ["[[Echo geometry]]", "[[Literature - Sato-Oyelaran clock stability]]"]
tags: [signals, stability]
---

# Stability analysis

Does the dish ring hold phase lock at operating power, and how far from losing it is it? Owner: Sef. Method after [[Literature - Sato-Oyelaran clock stability]]; geometry from [[Echo geometry]].

## Question

A ring of phase-locked feeds can hold a beam only while small disturbances in drive current decay rather than grow. If one petal runs slightly hot, the lock must pull it back. Past a critical power the ring stops correcting itself and one mode grows until the beam breaks up. We need that critical power, and the margin between it and P 0.62.

## Method

1. Linearise the ring's coupled-oscillator equations about a steady beam at power P.
2. Decompose disturbances into the ring's azimuthal modes, m = 0 to 6 (twelve petals give six independent mode pairs plus the breathing mode).
3. For each mode, compute the growth rate as a function of P, including the alternating 14° tilt.
4. Check against calibration data: deliberately unbalance one petal's drive by 0.5 % and watch the mode decay.

The check used sweeps CS-18 to CS-26, all below P 0.25.

## Result

| Mode | Character | Critical power | Margin at P 0.62 |
|---|---|---|---|
| m = 0 | Breathing (all petals together) | none found to P 0.95 | large |
| m = 1 | Beam shifts sideways | 0.88 | 0.26 |
| m = 3 | Triangular | 0.79 | 0.17 |
| **m = 6** | **Alternating, follows the tilt pattern** | **0.71** | **0.09** |

The m = 6 mode sets the limit. At P 0.62 the ring is stable with a power margin of 0.09, equivalent to about 7 % in drive current. Petal-to-petal drive matching must stay within 0.4 % to keep that margin intact; this flows into the [[Dish array design]] as a balance requirement.

Calibration decay rates matched prediction within 12 % for every mode measured.

## What stability analysis says about echo 47

Nothing. That is the finding, and it is worth writing down.

Echo 47 reached P 0.34 for 3.0 s. Every mode is strongly damped at 0.34; the nearest instability is twice as high. The analysis predicts a quiet, boring send. The drive current traces from echo 47 are quiet and boring, apart from the excursion itself. Whatever happened on echo 47 was not a lock instability in the sense of this note.

Teodor reads this as support for an instrument fault: if the beam was stable, the oddities must be in the instruments ([[Lab notebook — Teodor]]). Imani reads it the other way: if the beam was stable and the oddities are real, the oddities are not in the echo model at all ([[Lab notebook — Imani]]).

## Limitations

- The analysis is linear. It says nothing about large excursions.
- It treats the cold receiver face as a fixed boundary, as [[Echo geometry]] does. A face that moves, rings or absorbs energy is outside the model.
- It has no term for anything outside the ring. Sato and Oyelaran assumed the space beyond was "otherwise quiet"; so do we.

> [!note] Sef
> I have checked the m = 6 margin four times and it holds. I have also checked, four times, that this note has nothing to say about the 1.92 kHz line in the strain channel. It does not. Something else does, or nothing does. Listed in [[Open questions]].
