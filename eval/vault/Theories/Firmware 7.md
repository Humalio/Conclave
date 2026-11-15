---
owner: The Annex
status: active
depends_on: ["[[CAP-014 Air-gapped capture]]", "[[CAP-012 Baseline listen]]", "[[Build 7 test report]]", "[[What answers us]]"]
tags: [theory, firmware-7, official, explanation]
---

# Firmware 7

The official explanation for the echo. Owner: Hesper. Reviewer: Halden. Revision C, 30 May 2191. This is the Authority's line, and the line every public statement quotes.

> **Theory, as filed:** relay firmware build 7 stamps receive times wrong. Under high transmit power the receive path is stamped from a stale clock register, so a reply that arrives *after* the send is logged 0.71 s *before* it. Nothing arrives early. The clock lies about when.
>
> **Status:** official. Pushed by the Authority. Stands until CAP-014 reports.

## Scope

Firmware 7 is the receive-timing firmware on every relay of the Meridian Net. It reads the receiver's sample counter, latches the relay clock and writes the receive stamp to the log that ORRIN reads. "Firmware 7" is also, by now, the name of the explanation; the file predates the echo and nobody has had the afternoon to split it.

The receivers run with their front ends at **40 K** on Tern-9's cryo-cooled dish. Everything in [[Dish array design]] assumes the explanation below: if the fault is in the stamp, the rebuild only needs to fix the stamp.

## Vendor and build lot

- Vendor: Pellam Systems.
- Build lot: **B7-L07** ("build lot 7"). Every receiver board at Tern-9, and the boards in the CAP-014 rack, were flashed from it.
- Lot acceptance rests on Pellam's release notes and the lot cover sheet. Pellam's own test report ([[Build 7 test report]]) has not reached this folder; the Annex has never seen it.
- Open: [[B-01 Firmware 7 fault]] (28 May) flags a traceability gap in the build 7 release notes. See [[Vendor audit]].

## Timing figures at 40 K

| Figure | Value | Source |
|---|---|---|
| Stamp resolution | 0.5 ns | lot cover sheet |
| Receive latency, low power | 212 ns (± 1.1 ns) | [[CAP-012 Baseline listen]] |
| Receive latency, power 0.30 | 214 ns | CAP-012 |
| Stamp margin against R5 | +38 % | CAP-012 |
| Register refresh interval | 0.71 s | Pellam datasheet |
| Design life | ≥ 600 transmissions at operating power without a mis-stamp (R4) | [[Timestamp fault model]] |

The register refresh interval is the whole case for this explanation. A stamp taken from a register one refresh stale would be early by exactly 0.71 s. No other number in the firmware comes close. The baseline listen stamped every reply correctly below power 0.30, and the curve sits in [[cap-012-baseline.csv]].

## Front-end response

Receiver front-end gain at 40 K, measured on lot 7 boards, March 2191.

| Frequency | Relative gain |
|---|---|
| 1.4 GHz | 1.00 |
| 1.6 GHz | 0.99 |
| 1.8 GHz | 0.97 |
| 2.0 GHz | 0.91 |
| 2.1 GHz | 0.88 |
| 2.2 GHz | 1.12 |
| 2.3 GHz | 1.31 |
| 2.4 GHz | 1.09 |
| 2.6 GHz | 0.62 |

The standard relay front end has a gain **peak** near **2.2–2.4 GHz**, outside the traffic band. Struck there, a receiver rings for most of a second. This is a known trait of the front-end filter and is in Pellam's own datasheet.

Disposition: outside the timing path. The [[Timestamp fault model]] covers the clock register and the sample counter, which is where a stamp error lives. Logged for completeness.

> [!note] Review comment (Halden, 21 May)
> "Logged for completeness" is how things end up in an incident report. Who decided the front end is outside the fault, and has anyone looked at 2.3 GHz on a real echo?
>
> Reply (Hesper): The timestamp fault model. Firmware cannot ring a filter. If Signals Lab shows the ring in the stamp path, we move the model.
>
> Halden: Noted. Not resolved. And a stale register would be stale at every power. The echo only comes above 0.32.

For comparison, [[Q-9 quiet receiver]] has its front end shielded outside the 2.3 GHz band. Recorded there; no action.

## Qualification status

1. Baseline: passed ([[CAP-012 Baseline listen]]).
2. Air-gapped: [[CAP-014 Air-gapped capture]] **running, result pending**. Firmware removed, ORRIN disconnected, a hand-clocked receiver. If Firmware 7 is the cause, there is no echo to log. Transmissions 201–800 step up from power 0.25 to 0.33 once the cap is raised.
3. Fleet: patch plan for all forty relays drafted; see [[Case file AT-0412]].

M3 "Explanation qualified" (due 31 Jul) waits on item 2.

## Changes

- Rev A, Jan: initial, from Pellam datasheet.
- Rev B, 12 Mar: CAP-012 results; front-end table added.
- Rev C, 30 May: qualification status; link to B-01.

> [!note] Vesna
> If CAP-014 logs one echo with no firmware in the room, this page is the most-quoted wrong answer in the Net. The test is already running. Go and watch it: [[CAP-014 Air-gapped capture]].
