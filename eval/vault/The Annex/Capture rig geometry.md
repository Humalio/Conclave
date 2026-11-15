---
owner: The Annex
status: frozen
depends_on: ["[[Firmware 7]]"]
tags: [receivers, rig, test]
---

# Capture rig geometry

Receiver drawings for the capture campaigns. Owner: Rafi. Frozen 8 April 2191 (drawing AN-C-014, rev D).

## The receivers

Six capture receivers, **R-1 to R-6**, built from build lot P7-L07 boards (see [[Vendor audit]]), plus four baseline receivers (B-1 to B-4) for [[CAP-012 Baseline listen]].

| Dimension | R-series (capture) | B-series (baseline) |
|---|---|---|
| Overall | 180 × 60 × 4.4 mm | 220 × 25 × 4.4 mm |
| Sense strips | 11, 0/±60 | 11, 0/±60 |
| Feature | central mounting boss, Ø 12 mm port | plain strip |
| Pickup concentration | Kt 2.1 at the port | 1.0 |
| Edge finish | diamond-ground, Ra ≤ 0.4 µm | same |
| Probes | 3 per receiver, rosette at the port | 1 axial |

The port reproduces the busiest detail on the real shroud: the bolt boss where each [[Shielding interface]] bracket lands. If a receiver picks up anything odd, it picks it up there first. That is the assumption, and the [[Timestamp fault model]] takes Kt from this table.

## Fixture layout

The R-series sit in a ring of six on the cold fixture in Cold bay 2, cold face toward the bench array, at 60° spacing, so each receiver sees the beam at the same radius. Positions are numbered clockwise from the cryo feed. The fixture's backing plate is plate stock supplied by Tern-9's stores (see [[Dish panel 7 (the one nobody ordered)]]); the receivers are bolted through a 0.5 mm PTFE shim and never touch it directly.

The receivers carry twelve marked inspection sites each: the port rim at 12, 3, 6 and 9 o'clock, the four corners, and four along the mid-span centreline. Every inspection reports against those twelve sites so the [[cap-014-echoes.csv]] log has fixed columns.

> [!note] Rafi
> Twelve sites per receiver was chosen to keep the log readable. If something ever shows up between two sites, it will be recorded at the nearest one. Accepted limitation.

## Changes

- Rev C, 2 Apr: port diameter 10 → 12 mm to match the shroud drawing.
- Rev D, 8 Apr: added the PTFE shim after fretting marks on the trial receiver. Frozen.
- 6 May: a second set of six (same drawing, same lot) was built for the Cold bay 3 repeat, [[CAP-014b Empty dish]], mounted on an autoclaved fixture with a new backing plate from fresh stock.

## Review

> [!note] Halden, 9 April
> Fine. One question for the record: R-3 came back from teardown after the 9 April alarm with something on its cold face that the cleaning log calls "film". The drawing has no provision for receiver contamination. Is the receiver still a valid specimen, or a different one now?
>
> Rafi: Out of scope for a drawing. Whatever it is belongs to Xenobiology now. See [[IR-0412 Tern-9 cryo alarm]].
>
> Halden: That answers who owns it, not what it did to the receiver.
