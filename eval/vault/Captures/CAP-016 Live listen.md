---
owner: Relay Engineering
status: paused
depends_on: ["[[Dish test plan]]", "[[Transmit sequence]]", "[[Capacitor bank]]"]
tags: [live-listen, subscale, m4, receiver-bay]
---
# CAP-016 Live listen

Capture lead: Brannoc. Console: Lusa. Clock: Teodor (Signals Lab, on loan). Series opened 28 January 2191.

## Purpose

Walk the full charge-hold-send-listen sequence up in power on the 1:20 subscale dish in receiver bay 2, before anyone tries it at full scale for M4 (ground live listen). Each live listen is one transmission: charge per [[Transmit sequence]], hold at target power for 3.0 s, send timed by the relay clock, then listen. The series is the evidence base for [[Dish array design]] and for the shutdown timing in [[Shutdown criteria]].

Transmissions are numbered globally across all Tern-9 test stand work, so the live listens are not consecutive.

## Series

| LL | Tx | Date | Target p | Reached p | Hold | Outcome |
|---|---|---|---|---|---|---|
| LL-01 | 31 | 4 Feb | 0.20 | 0.20 | 3.0 s | Clean. Send within 3 ns of the predicted 412 µs slot |
| LL-02 | 39 | 18 Feb | 0.23 | 0.23 | 3.0 s | Clean. Bank recharge 88 s |
| LL-03 | 47 | 3 Mar | 0.25 | █████ | █████ | See page 3 |
| LL-04 | 55 | 16 Apr | 0.28 | 0.28 | 3.0 s | Clean. Under the 0.30 cap |
| LL-05 | — | — | 0.30 | — | — | Paused |

The 3 ns on LL-01 is the number the relay clock design was sized around (requirement R5, ≤ 4 ns). It held on LL-02 and LL-04 as well.

## Page 1: LL-01 and LL-02

First charges on the subscale dish. The cold fixture was rebuilt with its new tile set beside dish panel 7 on 26 February, after LL-02, so LL-03 was the first live listen on it. Nothing to report beyond the table. Bank energy drawn: 0.41 GJ and 0.47 GJ. Surge detector quiet. Strain on the cold fixture stayed inside the model band (40–400 Hz) on both transmissions.

## Page 2: LL-04

Transmission 55, 16 April. First live listen after the 4 March cap, held to p 0.28 to stay clear of the interlock at 0.30. Clean on every channel. Reply logged once, at the expected time. No acoustic events in the bay. By then the cold fixture had been cleaned after IR-0412 and the frost sample had been removed.

## Page 3: LL-03

█████ ███ ██ ██████ ███████ ███ ██████ █████ ██ ██ ████ ███████ ████ ████ ████ ████ ██████ ███ █████ ██████ ███████ ███ ███████ ██████ ████ ██ ███ ████ █████ ████ ████████ ███ ████████ ████ ███ ██ ███████ ██████ ███ █████ ████ █████████ ██ ████ ███ █████████ ████ ████████[^1]

The raw recording is not withdrawn: [[live-listen-03.bin]] and its sidecar [[live-listen-03.json]] are on the stand archive. The account of the transmission that we are allowed to keep is [[Echo 47 (why we stopped)]].

## LL-05

Planned at p 0.30, the cap itself, to close the subscale series and hand over to the full-scale M4 preparation. Postponed without a date under the 4 March order. Stays paused until the echo model update lifts the cap.

> [!note] Brannoc, 1 June
> M4 is planned off the back of LL-05. LL-05 is planned off the back of a memo nobody on this team has read. I would like that written down somewhere, so here it is.

## Data

- [[live-listen-03.bin]]: four channels (transmit power, receiver strain, dish temperature, clock phase), float32.
- [[dish-thermal.csv]]: dish temperatures for LL-01, LL-02, LL-04.
- Transmission-by-transmission notes: [[Listening log]].

[^1]: Redacted under [[Do not circulate - echo 47]].
