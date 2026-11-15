---
owner: Classified
status: closed
depends_on: []
tags: [classified, vendor, firmware-7]
---
# Build 7 test report

**Pellam Systems — Build Conformance Report PS-BCR-2191-0412**
Customer: Halcyon Relay Authority (the Echo Case), via the Tern-9 refit contract.
Product: relay receive-timing firmware, build 7. Build lot: **B7-L07**. Issued 29 May 2191 at the customer's request.

## Scope

This report answers the customer's question of 28 May 2191: "Does build 7, lot B7-L07, stamp receive times within specification, and is there any record of a timestamp or traceability deviation?" It covers all 14 receiver boards and 36 spare modules flashed from lot B7-L07, including the boards in the Tern-9 dish rack.

## Results

| Property | Specification | Build 7, lot B7-L07 (mean / worst) | Conforms |
|---|---|---|---|
| Receive stamp accuracy | ≤ 4 ns | 0.8 / 1.9 ns | Yes |
| Register refresh skew | ≤ 10 ns | 2.1 / 3.6 ns | Yes |
| Stale-register reads | 0 in 10⁹ | 0 | Yes |
| Stamp order (send before receive) | Always | Always | Yes |
| Regression soak (22 h) | Profile PS-R7 | Profile PS-R7, no excursion | Yes |
| Release notes | Signed, traceable | Signed 11 Jan 2191, build chain complete | Yes |
| Cold screen (50 cycles, 300 K ↔ 40 K) | No mis-stamp | None found | Yes |

## Traceability

The customer's blocker refers to a "traceability gap in the release notes". Our records show no gap. The release notes for B7-L07 were signed on 11 January 2191 and are cross-referenced to soak log PS-SK3-0111. A *copy* forwarded through the refit contract on 14 January lacked page 2, which carries hours 14 to 20 of the 22-hour soak (after the lot moved from rig SK3 to SK4 at hour 14). The original is complete and shows no excursion. We attach it.

## Conclusion

Build 7, lot B7-L07, conforms to specification in every respect tested. Pellam Systems has no record of a timestamp, firmware or traceability deviation for this build. There is no timestamp defect.

We note, without comment, that the customer's question concerns receive stamps logged before the corresponding send. Firmware cannot stamp an event before the event reaches the board. If a board stamped a reply early, the reply was on the board early.

We note also that specification PS-S7 covers the timing path for the 1.4–2.0 GHz traffic band. We have not been asked for, and have not tested, front-end behaviour near 2.3 GHz.

*Addendum, 30 May 2191.* We decline the request of 29 May to reissue the build 7 release notes with a timestamp defect. Release notes state what was tested; we will not add a defect we did not find.

*For Pellam Systems: T. Rensaw, Quality Director.*
