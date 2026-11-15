---
owner: Signals Lab
status: active
depends_on: ["[[Echo geometry]]", "[[Lead time vs transmit power]]", "[[Stability analysis]]", "[[Echo decay]]"]
tags: [signals, echo-model, m1]
---

# Echo model v1

The baseline echo model of the Echo Case. Issued 12 February 2191 by Signals Lab (Orla, lead). The dish, clock and receiver designs in progress are all built against v1. Version 2 is in preparation for milestone M1 (30 June); until it is issued, v1 is the model of record.

## What the model contains

v1 is the composition of four Signals Lab results:

| Component | Source | Role in the model |
|---|---|---|
| Ring and beam geometry | [[Echo geometry]] | Pattern shape for a given PA drive set |
| Power law | [[Lead time vs transmit power]] | P ≈ k · I², k = 0.00183 per A² |
| Mode stability | [[Stability analysis]] | Limits: m = 6 critical at P 0.71 |
| Ring-down | [[Echo decay]] | Fast and slow stages after a send |

Given the twelve drive currents as functions of time, v1 predicts coupler power, rim gradient at the cold face, lock margin, and the ring-down profile after the send ends.

## Validation status

| Quantity | Range validated | Evidence | Residual |
|---|---|---|---|
| Coupler power | P 0 – 0.30 | Calibration sweeps CS-1 to CS-46, CS-55 | < 1 % |
| Rim gradient | P 0 – 0.25 | Fixture probes, CS-31, CS-39 | 4 % |
| Mode decay | P 0 – 0.25 | CS-18 to CS-26 | 12 % |
| Ring-down τ | P 0.10 – 0.30 | Calibration sweeps | 3 % |

Requirement R2 asks for a model "frozen and validated" before the dish design review. v1 is validated below P 0.30 and extrapolated above. The long-haul beam operates at P 0.62.

## Known gaps

Recorded honestly so that v2 can close them:

1. **No cold-face mechanics.** The cold receiver face is a passive conducting boundary. It cannot vibrate in v1.
2. **No frequency content above 400 Hz.** The PA switching band ends there; so does the model.
3. **No coupling outside the beam.** The space beyond the beam is assumed to carry nothing back.
4. **Echo 47 not reproduced.** With the recorded drive, which never left the 0.25 profile, v1 predicts P 0.25, not the 0.34 the coupler showed. Nor does it predict the reply stamped 0.71 s before the send command, the ticking on the dish-house microphone, or the 1.92 kHz line in strain. See [[Second timestamp]].
5. **Echo 52 not reproduced.** v1 has no mechanism for a 40 ms excursion to P 0.36 on a message that was queued at 0.29 and never sent.

## Echo model v2 (in preparation)

Signals Lab has told Case Command that v2 will extend validation above P 0.30 and add a cold-face response term. Two facts constrain that:

- No validation transmission above P 0.30 is permitted under the cap of 4 March ([[Decision log]] D-005).
- [[CAP-014 Air-gapped capture]] transmissions 401–1000 are scheduled at P 0.33 "per the echo model update (pending)". The pending update is v2. v2 is waiting on data from above P 0.30. The only planned data above P 0.30 is CAP-014.

The loop is noted here without further comment.

## Using v1

- Cite v1 by name and section in any note that uses it.
- Do not quote v1 predictions above P 0.30 without the word "extrapolated".
- Do not use v1 to argue about echo 47. It was not built for echo 47 and it does not know about it.

> [!note] Orla
> v1 is a good model of the relay we thought we were operating in February. I would like v2 to be a good model of the one we have.
