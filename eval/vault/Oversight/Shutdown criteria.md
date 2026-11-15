---
owner: Disclosure Board
status: active
depends_on: ["[[Hazard log]]", "[[Relay clock design]]", "[[Exposure limit]]"]
tags: [safety, shutdown]
---

# Shutdown criteria

The conditions under which a charge, hold or transmission shall be shut down. Each trip shall assert the hard-wired shutdown chain, which then executes an [[Emergency silence]] within 200 ms (R9).

## Automatic trips

| Trip | Condition | Hazard | Source |
|---|---|---|---|
| T-1 | Surge detected in any feed module (detection ≤ 12 ms) | H-01 | [[Surge protection]] |
| T-2 | Feed current > 105 % of commanded | H-01, H-08 | Feed controller |
| T-3 | Transmit power > commanded + 0.02 | H-03, H-08 | Power monitor |
| T-4 | Receiver cold-face temperature > 46 K at any sensor | H-03, H-05 | Cryo plant |
| T-5 | Keeper-quarters signal level > 2 % of dish-face level | H-02 | Leakage monitors |
| T-6 | Relay clock oscillator failure, or PC-A/PC-B disagreement > 0.5 ns. Holdover during a transmission is normal and does not trip | H-06, H-07 | [[Relay clock design]] |
| T-7 | Bank fault | H-04 | Bank controller |
| T-8 | Dish mount strain outside envelope | H-03 | Strain gauges |

## Manual shutdown

2.1 The keeper on watch and the second keeper each have a shutdown switch. Either alone shall shut down.

2.2 Manual shutdown shall be used for any condition the keepers judge unsafe and the automatic trips do not cover. Keepers shall not be required to justify a manual shutdown.

## Inhibits

3.1 No trip shall be inhibited while the relay is on air.

3.2 On the dish test stand, T-5 may be inhibited for transmissions with the leakage survey array removed, with the Disclosure Board's written consent.

## Notes

4.1 T-3 was added on 4 March, the day after echo 47 exceeded its planned power by 0.09.

4.2 T-8 uses a strain envelope derived in [[Dish mount reinforcement]] at 40–400 Hz. Strain content outside that band is not assessed by the envelope.

4.3 Every trip assumes that the condition it watches comes before its consequence. A trip on power fires after power exceeds its limit; a trip on strain fires after strain exceeds its envelope. The Board has asked the Timekeepers whether any of the echo 47 records contradict that assumption. The question remains open.
