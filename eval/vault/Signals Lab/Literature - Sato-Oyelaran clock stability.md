---
owner: Signals Lab
status: active
depends_on: []
tags: [signals, literature, stability]
---

# Literature - Sato-Oyelaran clock stability

Reading note by Sef. Reference: M. Sato and T. Oyelaran, "Mode stability of ring-coupled oscillator arrays under heavy drive", *Annals of Applied Signal Physics* 12 (2181), pp. 77–119.

## Summary

Sato and Oyelaran took Arden's four-feed tabletop ring and asked the question Arden had not: how many feeds, in what arrangement, can hold phase lock under heavy drive without one of them running away? They generalised the coupled-oscillator equations to N feeds, decomposed disturbances into azimuthal modes, and derived a closed-form stability criterion for each mode as a function of power, feed tilt and drive balance.

Their main results:

1. **More feeds, more stable.** Critical power rises with feed count up to about N = 12, then saturates. Twelve is the sweet spot; sixteen buys almost nothing and costs a third more mass.
2. **Uniform tilt is a trap.** A ring with all feeds tilted the same way has a soft m = 1 mode that loses lock at very low power. Alternating the tilt moves the weakest mode to the highest order, m = N/2.
3. **Balance matters more than strength.** A 1 % drive mismatch between neighbours costs more stability than a 10 % drop in mean drive.

## How we use it

- The twelve petals and the alternating 14° tilt in [[Echo geometry]] come straight from results 1 and 2.
- The mode decomposition and the m = 6 limit at P 0.71 in [[Stability analysis]] follow their method, with our ring's constants.
- The 0.4 % balance requirement in the [[Dish array design]] is result 3 applied to our margin.

## Validation in the paper

The authors verified the criterion on a six-feed bench ring up to P 0.05, and on numerical models up to P 0.9. Their bench ring had no cryogenic face; the feeds sat in free space with nothing at the rim. They note in passing that "rim structures are expected to be electrically passive and are omitted".

## Limitations for our use

- **Power.** Bench verification stopped at P 0.05. Our long-haul beam is at 0.62. Everything above 0.05 in the paper is theory.
- **Cold face.** The paper never had a cold receiver face. Ours runs at 40 K in the steepest part of the rim gradient. If the face is not electrically passive, the paper has nothing to say about it.
- **Outside.** Like Arden's decay model, the analysis assumes the space beyond the ring is "otherwise quiet". Stability is a property of the ring alone.

## Assessment

The best paper in the field and the reason the dish ring looks the way it does. It is also a paper about feeds, not receivers, written by people who never sent a transmission strong enough to hear one ring. For the question it asks, I trust it completely. For the questions in [[Open questions]], it is silent.

> [!note] Sef
> Oyelaran answered one email in March. Asked whether anyone had seen a ring "do anything early", the reply was one line: "Only Arden, and Arden took it back." See [[Literature - Arden 2179 on early replies]].
