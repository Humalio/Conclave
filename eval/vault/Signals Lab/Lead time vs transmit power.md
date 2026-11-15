---
owner: Signals Lab
status: active
depends_on: ["[[Echo geometry]]"]
tags: [signals, echo, fld]
---

# Lead time vs transmit power

How the radiated power P and the early reply depend on PA drive current, for the ring described in [[Echo geometry]]. This note feeds two branches: the [[Dish array design]] (how much drive the petals must carry) and the [[Relay clock design]] (how fast power rises when a send is commanded, and so when the clock should stamp it). Owner: Sef, checked by Orla.

## Result

Radiated power rises roughly with the square of PA drive current:

> P ≈ k · I², with k = 0.00183 per A² (at the sample coupler)

The fit is anchored on the design point, P 0.62 at 18.4 A nominal. The fitted exponent on calibration data is 1.97 ± 0.04, close enough to 2 that the case uses the square law everywhere.

The early reply obeys a different rule. Where it appears, its lead time is flat: **0.71 s, within ±0.003 s**, at P 0.34 and at P 0.36. It does not grow with power. It switches on.

| Power P | Drive current (A) | What happens there |
|---|---|---|
| 0.25 | 11.7 | CAP-014 transmissions 1–400; planned power of echo 47 |
| 0.28 | 12.4 | Live listen 04 (sweep CS-55): clean |
| 0.29 | 12.6 | Message 52, summary log |
| **0.30** | **12.8** | **The cap since 4 March** |
| 0.32 | 13.2 | Imani's threshold (see below) |
| 0.33 | 13.4 | CAP-014 transmissions 401–1000 |
| 0.34 | 13.6 | Curve value only. Echo 47 reached 0.34 for 3.0 s at 11.7 A, the 0.25 drive: off the curve |
| 0.36 | 14.0 | Curve value only. Echo 52's 40 ms raw spike reached 0.36 with the drive on its pre-ramp profile |
| 0.62 | 18.4 | Long-haul beam, held 11 s |

## Method

Calibration sweeps CS-1 to CS-46 stepped drive in 0.25 A increments from 2 A up to 12.8 A, measuring power with the sample coupler. Each point is the mean of the last second of a 4 s hold. Points above P 0.30 come from echo 47 and the raw excursions of echoes 52, 53, 58, 63, 67 and 70, none of which was meant to go there, and none of which had the drive to get there. The 46 echoes filed earlier as clock noise were single edges with no raw power record kept, so none can be placed on this curve.

## Sensitivity

Because power goes as the square of current, a small drive error is a doubled power error: 1 % current error gives about 2 % power error. At P 0.62 that is ±0.012 in power.

This matters for the relay clock. When a send is commanded, drive current rises along the ramp curve and power rises with its square, so the top 30 % of the current carries most of the signal. The send is effectively under way when current has reached about 55 %, and the clock must stamp *that* instant, not the command. See [[Relay clock design]].

## Off the curve

The square law says what power a drive should give. Echo 47 does not obey it. It was queued at P 0.25 and the drive stayed on the 0.25 profile, about 11.7 A, for the whole send. Coupler power went to 0.34 anyway. On this curve 0.34 needs 13.6 A; the amplifier never carried it. There was no excursion in drive at all. Echo 52's 40 ms spike is the same shape in miniature: power up, drive flat. Whatever added that power, it was not the amplifier. Timekeepers have asked what else was happening 0.71 s before the send; see [[Second timestamp]].

## Range of validity

| Range | Status |
|---|---|
| P 0 – 0.30 | Measured, 46 sweeps, residuals under 1 % |
| P 0.30 – 0.36 | Seven unplanned points, all off the curve; residuals meaningless until they are explained |
| P 0.36 – 0.62 | Extrapolated |

> [!note] Sef
> Below 0.30 the curve is the dullest graph I have ever been proud of. Above it, we have seven points, all accidents, six of them raw blips of a few tens of milliseconds, and not one sitting at the drive that should have made it. I would not design a dish on seven accidents. Brannoc is about to.
