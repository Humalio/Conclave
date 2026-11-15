---
owner: The Annex
status: closed
depends_on: ["[[Capture rig geometry]]"]
tags: [firmware-7, baseline, receiver]
---
# CAP-012 Baseline listen

Capture lead: Rafi. Review: Halden. Tern-9 test stand, receiver bay 2, warm and cold rig, 2–11 March 2191. Closed 12 March. Result carried into [[Firmware 7]] rev B.

## Purpose

Establish the baseline for receive-time stamps and early replies on relay firmware build 7, at room temperature and at the receiver's operating temperature of 40 K, before any high-power work. A clean baseline is the floor the [[Timestamp fault model]] builds on; if this fails, nothing else matters.

## Method

Four baseline sessions, B-1 to B-4, on the bench receiver chain to the rig drawing in [[Capture rig geometry]]. B-1 and B-2 ran with the receiver face at 20 °C; B-3 and B-4 with the face at 40 K in the cold box. Each session sent 240 low-power transmissions (power 0.15–0.20, one every 30 s) and logged the send time and the stamped receive time of every reply. One strain gauge on the receiver face, plus the reference clock. Channels logged at 50 Hz: [[cap-012-baseline.csv]].

## Log

```
02 Mar 09:30  B-1 warm. 240 tx. 0 early replies. stamp scatter clean.
02 Mar 15:10  B-2 warm. 240 tx. 0 early replies. stamp scatter clean.
09 Mar 08:45  cold box at 40 K. stable 2 h.
09 Mar 11:20  B-3 cold. 240 tx. 0 early replies.
11 Mar 10:05  B-4 cold. 240 tx. 0 early replies.
11 Mar 10:40  all four logs archived. no gaps, no duplicate stamps.
```

## Result

| Quantity | Measured | Basis for |
|---|---|---|
| Early replies, all four sessions | 0 of 960 | Firmware 7 |
| Stamp error, RMS | 0.27 ns warm; 0.29 ns cold | Timestamp fault model |
| Margin on the timestamp scatter limit | 2.1× | Disclosure case §4 |
| Scatter between sessions | 2.1 % | — |

**Passed.** Build 7 stamps consistently at low power, and slightly tighter cold than warm, which is what a healthy receiver chain looks like. The logs show no gaps, duplicates or reordered stamps.

## Review

> [!note] Halden, 12 March
> Accepted. The logs are about as boring as receiver logs get, which is a compliment. I'd add one line for later: if build 7 ever turns out "bad", these four sessions were recorded on it and they are fine. Whatever is wrong with a build that stamps this cleanly, it isn't the stamping.

## What it does not cover

Low power only. Behaviour above the 0.32 line is [[CAP-014 Air-gapped capture]]. Receiver ringing and band response are measured separately and recorded in the Firmware 7 note's band table; this capture does not drive the dish into the high-power regime at all.
