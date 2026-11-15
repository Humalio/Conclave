---
owner: Case Command
status: active
depends_on: []
tags: [case-command, reference]
---

# Glossary

Terms used across the Echo Case vault. Curated by Quentin. If a team uses a word differently from this page, this page wins until someone changes it here.

## Net and echo

| Term | Meaning |
|---|---|
| **Meridian Net** | Forty relay stations from Mercury to the Kuiper edge, owned by the Halcyon Relay Authority ("the Authority"). |
| **Tern-9** | Relay no. 40, the furthest, 11 light-hours out. Four keepers, one cryo-cooled dish. |
| **Echo** | A reply to a relay transmission that arrives 0.71 s *before* the transmission leaves the dish. Numbered "echo N" in the order logged. Echoes 1–46 were filed as clock noise. |
| **Transmit power (p)** | Relative power of a transmission, 0 to 1. A routine relay pass runs at about 0.25. See [[Lead time vs transmit power]]. |
| **High power** | Any transmission above p 0.32. No echo has ever been logged below it. |
| **Dish array** | Tern-9's receiver dish and its panels. See [[Dish array design]]. |
| **Echo decay** | How the ring in a receiver dies away after an echo. See [[Echo decay]]. |
| **Echo model** | The signal model the dish rebuild is designed against. [[Echo model v1]] is current; v2 is in progress for M1. |

## Receivers and power

| Term | Meaning |
|---|---|
| **ORRIN** | The relay controller software. Runs every dish on the Net. |
| **Firmware 7** | Relay firmware build 7, supplied by Pellam Systems. The official explanation: build 7 stamps receive times wrong. See [[Firmware 7]]. |
| **Q-9** | Candidate replacement receiver: firmware-free, hand-clocked, 11 % less sensitive. See [[Q-9 quiet receiver]]. |
| **Build lot 7** | Pellam build lot B7-L07, the receiver boards installed at Tern-9 in the 2189 refit. |
| **Ring band** | The band near 2.3 GHz where receivers ring after an echo. |
| **Surge** | Sudden overload in the feed. Surge margin must be at least 15 % (R3). |
| **Bank** | The 2.1 GJ capacitor bank that charges the transmitter in 90 s. See [[Capacitor bank]]. |

## Timing

| Term | Meaning |
|---|---|
| **Relay clock** | Stamps every send and receive within 4 ns (R5). See [[Relay clock design]]. |
| **Holdover** | Running the clock without its external reference. Tested in [[CAP-011 Clock holdover]]. |
| **Lead-time error** | The scatter in the measured 0.71 s. Limit 5 ms (R6). |
| **Pulsar-fix** | Independent time solution from reference pulsars. See [[Pulsar-fix procedure]]. |
| **Second timestamp** | Timekeepers' name for the echo 47 receive logged twice, once 0.71 s before the send command existed. See [[Second timestamp]]. |

## Keepers

| Term | Meaning |
|---|---|
| **Echo sleep** | Keepers who sleep near the dish hear the reply in dreams before it arrives. |
| **EH** | Echo-hour, the exposure unit. See [[Exposure limit]]. |
| **Shielded bunk** | The countermeasure: a bunk screened from the dish house. |

## Test stand

| Term | Meaning |
|---|---|
| **Test stand** | Tern-9's transmit-and-listen rig, beside the main dish. |
| **Live listen** | A full-power transmit-and-listen on the test stand. LL-01 = echo 31, LL-02 = echo 39, LL-03 = echo 47, LL-04 = echo 55, LL-05 planned and paused. See [[CAP-016 Live listen]]. |
| **Air-gapped capture** | A capture with the firmware removed, ORRIN disconnected and a hand-clocked receiver. See [[CAP-014 Air-gapped capture]]. |
| **Empty dish** | The same capture with the frost scraped off and the dish face sterilised. See [[CAP-014b Empty dish]]. |
| **The cap** | Since 4 March, no transmission above p 0.30. See [[Decision log]]. |

## Specimen

| Term | Meaning |
|---|---|
| **The frost** | Glassy silica filaments a few microns wide on the dish's cold receiver face. Dormant when warm; active below 60 K, when it gives a faint tick. Catalogued as specimen F-3, kept at 35 K. The keepers call it "the rime" and will not say it near the dish. See [[Frost feeding log]]. |
