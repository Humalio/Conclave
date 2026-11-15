---
owner: The Annex
status: paused
depends_on: []
tags: [q-9, receiver, backup]
---

# Q-9 quiet receiver

Candidate replacement for the Firmware 7 patch: a firmware-free, hand-clocked receiver. Status: **parked as backup**. Owner: Vesna. Last touched 19 May 2191.

## Why it exists

Every official fix needs a fallback, and the case cannot afford to discover in August that it has none. Q-9 is the Annex workshop's answer to [[Firmware 7]]: no relay firmware, no controller in the loop, a clock wound by hand and read off a dial. It was evaluated in March alongside the patch and lost on mass and set-up time.

## Comparison with the Firmware 7 patch

| Property | Patched stock receiver | Q-9 | Note |
|---|---|---|---|
| Rack mass | 14.7 kg | 16.3 kg | **+11 %** |
| Clock | controller-stamped | hand-clocked | no software in the loop |
| Operating band | 0.5–2.6 GHz | 2.7–4.6 GHz | |
| Alignment cycle | 22 h | ~30 h | keeper time |
| Test data | [[CAP-014 Air-gapped capture]] running | none | [[CAP-015 Independent capture]] drafted, not started |

Mass is the deciding row. The extra 1.6 kg sits in the receiver bay, where [[Signal paths]] is already tight and where R8 (refit adds ≤ 6 % station mass) has the least slack. Alignment would also need the keepers' time; see [[Case file AT-0412]].

## Front-end rejection

Q-9's screened front end has a **broad rejection peak from 1.6 to 2.3 GHz**, up to 31 dB, against the stock receiver's 4 dB minimum in the same region. The screen does it: it turns signal energy in that band into a small amount of heat.

| Frequency | Rejection (Q-9) |
|---|---|
| 40 MHz | 9 dB |
| 400 MHz | 8 dB |
| 1.0 GHz | 14 dB |
| 1.6 GHz | 27 dB |
| 1.9 GHz | 31 dB |
| 2.3 GHz | 26 dB |
| 3.0 GHz | 12 dB |

In the 40–400 MHz band that the [[Timestamp fault model]] covers, Q-9 rejects slightly *worse* than the stock receiver. So on the case's own model it gives no benefit, and the peak was scored as "no credit".

> [!note] Review comment (Halden, 19 May)
> Scored "no credit" because the model has no content above 400 MHz. That is a statement about the model, not about the receiver. Leaving this here so someone finds it.

## Status and what would unpark it

Parked as backup by Hesper on 24 March. Vesna keeps it warm:

1. The Corvel instrument shop holds 600 g of screening foil on a reservation that expires 30 September.
2. CAP-015 is written and costed but has no rig; Cold bay 2 and Cold bay 3 are both booked through June.
3. [[Shielding interface]] bracket loads would need a re-run with the lower modulus. Dario estimates two days.

Unpark trigger: the Firmware 7 patch fails, or R4 moves. Neither is expected. CAP-014 stood at 480 transmissions with no early reply on 1 June.

## Risks if we switch

- Mass: +1.6 kg, or 0.02 % of station mass, against an R8 allowance already 5.4 % committed. Small, but it lands in the receiver bay. See [[Annex risks]].
- Schedule: the alignment cycle adds roughly three weeks to the refit.
- Data: zero hours of capture history. We would be starting cold, which in this building is a figure of speech.
