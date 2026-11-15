---
owner: Disclosure Board
status: open
depends_on: ["[[Hazard log]]", "[[Echo geometry]]", "[[Shielding interface]]"]
tags: [safety, hazards, h-02]
---

# Signal leak hazard

Hazard analysis for **H-02, signal leak into the keepers' quarters**. Severity II, likelihood D, risk class 2. Controls owned by The Annex and Relay Engineering jointly. Status open.

## The hazard

1.1 The dish shield keeps the transmitted signal inside the feed ring. Any signal that escapes the shield reaches the mount frame and, through it, the quarters and bunks either side of the dish bay.

1.2 Signal in the quarters adds echo-hour exposure on top of the exposure the [[Dose model]] predicts, and it does so unevenly: a keeper near a leak path receives more than the one in the next bunk.

1.3 Leak paths considered: cracks or gaps in the shield; cable and coolant penetrations through it; joints between shield segments; and misalignment between shield and feed ring.

## Limits

2.1 Signal strength anywhere in the quarters shall not exceed 2 % of dish-face strength during charge, hold or transmission.

2.2 No single bunk position shall see more than 1.5 times the quarters average.

## Controls

3.1 Shield integrity per [[Dish array design]] and the mount qualification (R4).

3.2 Penetrations: every penetration through the shield shall be a labyrinth with at least two bends, per the [[Shielding interface]]. Straight-through penetrations are prohibited.

3.3 Cable penetrations through the mount frame shall be sealed and surveyed before first power, per [[Cable routing]].

3.4 Leakage survey: a 64-point survey of the quarters shall be performed at each ground power test.

## Verification to date

4.1 Bench survey around the 1:20 subscale dish on the test stand, 12 transmissions at power ≤ 0.30: worst leakage 0.6 % of dish-face strength, at the coolant penetration.

4.2 Scaling to full size per [[Echo geometry]] predicts 0.9 %. Within limit.

## Open items

5.1 No survey exists above power 0.30. Leakage is assumed to scale smoothly with power. The Board has asked Signals Lab to state the basis for that assumption.

5.2 The test-stand strain channels on echo 47 recorded a line at 1.92 kHz during the high-power segment, which the bench survey model does not include. Whether it bears on leakage is unknown. Recorded as an observation.
