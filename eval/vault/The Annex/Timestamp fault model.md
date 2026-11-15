---
owner: The Annex
status: active
depends_on: ["[[CAP-012 Baseline listen]]", "[[Echo model v1]]", "[[Capture rig geometry]]"]
tags: [timestamp, firmware, model]
---

# Timestamp fault model

Predicts the receive-timestamp error of relay firmware build 7 under high-power transmissions. Owner: Rafi. Reviewer: Halden. Version 2.3, 14 May 2191.

## What it does

Each transmission ramps the amplifier, holds, and sends. The receive buffer sees one large burst per send plus a spectrum of smaller transients riding on top. The model turns that history into an expected stamping error (a buffer overflow term, with a correction for the 40 K receiver offset) and reports the early-stamp size at the worst channel of the relay.

R4 asks for an early-stamp below 50 ms at operating power. The model predicts that build 7 overflows its buffer above about power 0.30 and then stamps replies **0.6 to 0.8 s early**, which is the size of what Tern-9 reports and the reason [[Firmware 7]] looked right on paper.

## Inputs

| Input | Value | Source |
|---|---|---|
| Reference clock stability, buffer depth | 1e-12, 4 MB | [[CAP-012 Baseline listen]] |
| Overflow slope (40 K, R = 0.1) | m = 9.4 | Pellam data, lot 7 units |
| Receive spectra | **40–400 MHz** | [[Echo model v1]] |
| Pickup concentration at the port | Kt 2.1 | [[Capture rig geometry]] |
| Front-end rejection | η from the Firmware 7 table, 40–400 MHz only | Firmware 7 |

The receive spectra are the heart of it. Echo model v1 gives the front-end content as eleven discrete lines between 40 and 400 MHz, strongest at 118 MHz (the feed's breathing mode). We scale them with power squared, as [[Lead time vs transmit power]] does for current. Above 400 MHz the echo model carries no content, so neither do we.

## Method

1. Take the transmit profile for one burst (ramp, hold, send).
2. Build the buffer history at each of 96 channels from the echo-model spectra.
3. Count overflow events; correct for the receiver offset.
4. Sum the stamping error per channel; report the worst.
5. Calibrate against [[CAP-014 Air-gapped capture]] as it reports.

The subscale correlation is the weak point: the bench array in Cold bay 2 is 1:20, and signal levels scale but frequencies do not scale politely. We correct frequencies by the ring's geometric ratio and accept a factor-of-two scatter band.

## Validation so far

- CAP-012: baseline, matches within 4 %.
- CAP-014: 480 transmissions at power 0.25, result pending, no early reply so far, as predicted (the model says first overflow after about 29,000 transmissions at that power).
- Monitor probes on the run logs: the 118 MHz line is where the model puts it, within 3 MHz.[^1]

## Review

> [!note] Halden, 14 May
> The model is internally consistent. My worry is the boundary of the box, not the contents. We validate against the frequencies we chose to look for. Recommend one broadband record above 400 MHz before M3. Rafi says the data acquisition rate on the bench was too low until March; it isn't now.
>
> Rafi: Accepted as an action, low priority.

## Limits

- No thermal cycling term; the shroud stays at 40 K.
- No environmental term. Receivers are assumed clean.
- Nothing above 400 MHz.

[^1]: A 2.3 GHz line also appears in the run-47 monitor channel; nobody modelled it. It is outside the band, narrow, and present for under three seconds. See [[Echo 47 (why we stopped)]]. Raised by Halden on 14 May, parked with the broadband action above.
