---
owner: Signals Lab
status: active
depends_on: []
tags: [signals, literature]
---

# Literature - Arden 2179 on early replies

Reading note by Imani. Reference: L. Arden, "On the coupling of a transmit ring to its surroundings", *Proceedings of the Halvard Institute for Signal Physics* 41 (2179), pp. 211–238. Withdrawn in part by the author, 2180.

## Summary

Arden built the first tabletop transmit ring that could be keyed on and off on command: a four-feed ring 30 cm across, reaching P ≈ 0.004 in his own units for up to 2 s. That sounds weak. It is not: normalised to ring size, the way we quote power, his strongest sends are equivalent to about P 0.33 on our scale. A tiny rig, pushed hard. The paper has two halves, and the community remembers only one of them.

**The half everyone cites.** A careful, beautifully instrumented measurement of ring-down after the send. Arden separated a fast stage (following drive current) from a slow stage (an exponential tail), measured the slow time constant across 300 sends, and showed it grows with held power. Our [[Echo decay]] model takes its functional form and two of its constants directly from Arden.

**The half everyone forgets.** In section 6, Arden reports that a pickup loop placed *outside* the ring, 1.2 m away, recorded a weak transient on 23 of 300 sends. The transient arrived before the send that should have caused it, by a few hundred microseconds. Arden proposed, cautiously, that the space in front of the ring "may not be empty of structure", and that a transmission might couple to something beyond the ring that answers it.

## The withdrawal

In 2180 Arden published a short note withdrawing section 6. A colleague had found an impedance mismatch in the pickup loop's cable that could produce a reflection on the right timescale. Arden accepted the explanation, re-ran 40 sends with a corrected cable, saw no transient, and closed the matter.

The note does not say at what power the 40 re-runs were held. The original 23 events all came from the strongest sends in the series.

## Why we cite it

1. Decay constants (cited in [[Echo decay]] and [[Echo model v1]]).
2. The four-feed ring geometry, which Sato and Oyelaran later generalised to twelve petals ([[Literature - Sato-Oyelaran clock stability]]).
3. A warning about instrumentation: cable reflections can look like causality violations. Teodor quotes this one often ([[Lab notebook — Teodor]]).

## Reading notes

- Arden's section 6 events were all on sends above P 0.0039 in his units, the very top of his range, about 0.32 on our scale. Below that, none.
- His leads were a few hundred microseconds. Ours is 0.71 s. Arden's own table suggests the lead scales with rig size, and his ring was 30 cm across. I have not found a scaling that gets from his number to ours. I have not found one that rules it out. Arden did not remark on it. A threshold in power would not be explained by a cable.
- The pickup was outside the ring. Our clock's reply detector is inside the dish house but outside the petal ring itself. Calder confirms the analogy is "geometrically fair, physically unknown".
- Arden's phrase "something beyond the ring that answers it" has no follow-up in the literature. I searched eight years of citations. Nobody built on it, and nobody refuted it except Arden.

> [!note] Imani (margin)
> I am not saying echo 47 is Arden's echo. I am saying that the only other person who ever saw a reply arrive early was talked out of it by a cable, and that the 40 re-runs may have been too weak to see it. I keep checking this. See [[Open questions]].
