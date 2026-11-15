---
owner: Signals Lab
status: active
depends_on: ["[[Echo geometry]]", "[[Literature - Arden 2179 on early replies]]"]
tags: [signals, decay, echo-sleep]
---

# Echo decay

What the receiver does after the send ends. Owner: Orla, with Imani. Xenobiology's [[Echo sleep physiology]] uses the ring-down profile; Timekeepers use its timing.

## The picture

A strong send leaves the receiver front end excited in the 2.3 GHz ring band. While drive current flows the dish holds the beam at power P. At the end of the send the drive is dumped and the front end rings down to quiet. It does not snap. It decays in two stages:

1. **Fast stage.** Power falls with the drive current, along the square law in [[Lead time vs transmit power]]. Duration set by the PA gate: a commanded stop takes the beam down in about 40 ms at Tern-9. A surge-protected shutdown is slower, with τ ≈ 0.14 s, and is not how a send is meant to end.
2. **Slow stage.** The last few percent of ring amplitude decay on their own, with a time constant τ that grows with the power the send was held at.

The echo-sleep disturbance in keepers tracks the slow stage. The faster it settles, the less hum in the bunk.

## Result

| Held power | Slow-stage τ (s) | Residual ring after 2 s |
|---|---|---|
| 0.10 | 0.21 | < 0.001 |
| 0.25 | 0.48 | 0.004 |
| 0.30 | 0.57 | 0.006 |
| 0.62 (predicted) | 1.15 | 0.11 |

The first three rows are calibration data. The 0.62 row is extrapolated with the same model that [[Echo model v1]] uses. Xenobiology has asked for error bars on the extrapolation; we have given them the honest answer, which is "wide".

## The model

The decay model treats the space in front of the dish as a passive, lossy, *quiet* medium. Energy stored in the front end is dissipated locally, at the beam lips, as the ring dies away. No energy leaves the well; none comes back.

That last assumption is the convenient one. It is also the one Arden questioned in 2179 ([[Literature - Arden 2179 on early replies]]). Arden's tabletop ring reported a small signal in a pickup loop that arrived *before* the send that should have caused it. Arden withdrew the claim as a cable reflection the following year. We cite the paper for its decay constants, which are excellent, and not for its early reply, which the community has politely forgotten.

## Fit quality

Below P 0.30 the model fits the calibration ring-down within 3 % on every record but one. The exception is echo 47, where the slow stage is not a clean exponential: it carries a small oscillating residue that the fit cannot remove. Imani measured the residue's period; she has not written the number here, and asked that it go into [[Open questions]] instead "until somebody tells me it is a coincidence".

## Downstream

- [[Echo sleep physiology]] takes τ at 0.62 as its input.
- [[Lead-time error]] takes the residual ring after the fast stage, because residual ring at the end of a window is a timing offset.
- [[Echo model v1]] embeds this model unchanged.

> [!note] Imani (margin)
> "No energy leaves the well; none comes back." I keep reading that sentence. We have one transmission where something seems to have come back early. We have never measured whether energy leaves.
