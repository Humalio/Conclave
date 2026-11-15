---
owner: Timekeepers
status: active
depends_on: ["[[Lead time vs transmit power]]"]
tags: [timing, relay-clock]
---

# Relay clock design

The relay clock stamps every send and every receive on Tern-9. It times the send to within **4 ns** (R5), because every nanosecond of stamp error turns into a nanosecond of lead-time error and 0.3 m of range error ([[Lead-time error]]). Owner: Calder. Design authority: Mirela.

## What "the send" means

The amplifier does not start instantly. When a send is commanded, drive current rises along the ramp curve and power rises with its square ([[Lead time vs transmit power]]). Most of the signal is carried by the top third of the current. The clock therefore times the **effective send**: the instant current crosses 55 % of its hold value, when power has reached a third of its hold value and the beam is committed.

The clock does not time the command. It times the radiated power. That distinction will matter later.

## Architecture

| Block | What it is | Notes |
|---|---|---|
| Master oscillator | Two 10 MHz cryogenic ceramic resonators, CL-A and CL-B, in a 4 K can | Cross-compared every 10 µs; disagreement > 0.5 ns flags a clock fault (hazard H-06) |
| Reference | Net master time, disciplined to pulsar fix between sends | Clock runs in holdover during the send |
| Send estimator | Predicts the 55 % crossing from the ramp curve | Updated during the last second before the send |
| Trigger | Fires the PA gate switches on all twelve petal feeds | Fan-out matched to 0.2 ns |
| Timestamp unit (TSU) | Records events on two inputs | Input A: commanded (sequencer). Input B: detected (receiver). |

The full signal path is drawn in [[Timing chain]].

## Error budget

| Contribution | Worst case (ns) | Source |
|---|---|---|
| Oscillator drift over an 11 s hold | 0.55 | [[Clock drift model]] |
| Initial sync to Net time | 0.20 | Pulsar-fix residual |
| Send estimator | 1.20 | Dish-house data, ramp-curve fits |
| Trigger fan-out | 0.20 | Dish-house data |
| PA switch spread across twelve feeds | 1.00 | [[CAP-009 Dish surge]] switch data |
| Distribution and cabling | 0.50 | Design |
| **Linear sum** | **3.65** | Under 4 ns with 0.35 ns margin |
| Root-sum-square | 1.9 | For information |

We carry the linear sum. Calder's rule: "If you need the root-sum-square to close a budget, you do not have a budget, you have a hope."

## Verification

- Holdover and jitter: [[CAP-011 Clock holdover]], analysed in [[Holdover test]]. Jitter < 0.3 ns.
- Drift over a send: [[Clock drift model]], fitted to [[clock-drift.csv]].
- End to end in the dish house: every transmission records both TSU inputs, so the commanded send and the detected loopback tone can be compared. On every record but one, B follows A by 412 ± 3 µs, the group delay of the receive filter chain.

## The engineering clock and the relay clock

The engineering clock in the dish house is the reference model: the same oscillator type, a different build, the same TSU, longer cables. The replacement relay clock for Tern-9 is on order and late ([[B-02 Clock vendor delay]]). Until it arrives the engineering clock is also the holdover spare, not rated for station duty.

## Known issue

On echo 47, TSU input B (detected) recorded a reply at 22:14:06.290. Input A (commanded) recorded the send command at 22:14:07.000. A detected reply 0.71 s before the command is not something this design can produce. It has been examined at length; see [[Second timestamp]].

> [!note] Mirela
> The clock is designed to tell you when the send began. On one night in March it told us about a reply twice, and the first answer was earlier. The design is fine. It is the question that has changed.
