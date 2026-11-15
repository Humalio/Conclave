---
owner: Disclosure Board
status: active
depends_on: ["[[Hazard log]]", "[[Surge protection]]", "[[Dish array design]]"]
tags: [safety, hazards, h-01]
---

# Surge hazard

Hazard analysis for **H-01, feed surge during charge or hold**. Severity I, likelihood D, risk class 2. Owner of controls: Relay Engineering (Brannoc). Reviewer: The Annex and Disclosure Board.

## The hazard

1.1 A dish feed module surges when part of its line arcs or leaves its design range. The stored energy in that module, about 143 MJ at 18.4 kA (one twelfth of the array's 1.71 GJ), then dumps as heat into a short length of conductor.

1.2 An undetected surge can melt the line, rupture the feed cryostat and drive a pressure pulse into the receiver cold face. One module surging drops transmit power asymmetrically, which loads the dish mount unevenly.

1.3 Causes considered: conductor motion under load, local heating at joints, loss of cryogen, radiation heating, and manufacturing defects in the line.

## Controls

2.1 **Margin.** Every module shall operate with surge margin of at least 15 % at nominal current (R3). The [[Dish array design]] carries 16.7 %.

2.2 **Detection.** Voltage taps across every module half shall detect a resistive zone within 12 ms.

2.3 **Dump.** On detection, the [[Surge protection]] system shall fire dump resistors on all feed modules within 20 ms, so the dish goes quiet symmetrically. A single-module dump is not permitted.

2.4 **Shutdown.** A surge shall trigger the shutdown chain per [[Shutdown criteria]].

## Verification

3.1 [[CAP-009 Dish surge]] induced three surges with heater pulses on one bench feed module of the 1:20 subscale dish. Detection: 10–11 ms, inside the 12 ms requirement. Dump: about 140 ms. Peak line temperature: 71 K.

3.2 Full-scale surge testing is planned as part of the ground live listen (M4).

## Residual risk

4.1 Tolerable, subject to M4. The Board notes that the subscale module runs at a signal shape scaled from [[Echo model v1]]; the margin shall be rechecked against the frozen echo model at M1.

4.2 *Observation, 14 March:* on echo 47 the feed current stayed within limits throughout, and the surge detectors did not trip, although the dish reached power 0.34 against a plan of 0.25. Whatever drove the power over plan was not a surge.
