---
owner: The Annex
status: open
depends_on: ["[[Firmware 7]]"]
tags: [vendor, pellam, build-7]
---

# Vendor audit

Halden's audit of Pellam Systems as the supplier of relay firmware build 7. Owner: Halden. Revised 30 May 2191.

## Status

| Item | State | Date |
|---|---|---|
| Quality system audit | passed, 2 minor findings | 17 Jan |
| First article (lot P7-L05) | passed | 3 Feb |
| Qualification lot **P7-L07** | accepted on certificate | 11 Mar |
| Trial unit T-1 | passed bench scan | 6 May |
| Release record format | **open**, see below | 28 May |
| Second-source review | not started | not set |

Pellam remains the only qualified source of relay firmware. The [[Q-9 quiet receiver]] needs no firmware at all, so a switch would remove the vendor from the loop rather than replace it.

## The release record

Every build ships with a release record: the build and test trace for the whole run, the machine identity, the operator, and the lot number. Lot P7-L07's record, as we hold it, has a gap. The run is 22 hours; our copy carries the trace for hours 0 to 14 and 20 to 22 only. Hours 14 to 20, the conformance test at peak load, read "trace not retained", and the machine identity field for that stretch says "transferred" with no machine named.

Pellam's quality office answered on 29 May:

> The trace for P7-L07 is complete and continuous. The copy you hold appears to be missing a page. The full original, with our conformance report, has gone to the customer's procurement contact today.

That is a reasonable answer, and it is also exactly what a vendor would write either way. The "procurement contact" is the Authority's liaison, so the report went to the director's office, not to us. As of 1 June it has not reached this folder. Halden opened [[B-01 Firmware 7 fault]] on 28 May to hold the question in one place: if CAP-014 shows anything odd, lot 7 is the first suspect because it is the only lot whose paperwork we cannot fully close.

## Findings log

1. **17 Jan, minor.** Build server log had a gap of six hours over a holiday. Closed: no out-of-limit event.
2. **17 Jan, minor.** Two operators' training records unsigned. Closed 2 Feb.
3. **28 May, open.** Lot P7-L07 release record: hours 14 to 20 of the trace missing from our copy, machine field incomplete. Full original requested; Pellam says it was sent on 29 May.

## What lot 7 went into

- Receivers R-1 to R-6 and the baseline units ([[Capture rig geometry]]).
- [[CAP-014 Air-gapped capture]] captures.
- The second receiver set for [[CAP-014b Empty dish]].
- Trial unit T-1.

So if lot 7 is bad, every capture we hold is from bad firmware. That cuts both ways: it would also mean every *pass* is in doubt.

## Contacts

Vendor correspondence goes through the Authority's contracts office and its procurement liaison, Corin Ashdale, because the build 7 order sits under the Authority's contract, not ours. The Annex talks to Pellam's engineers directly but cannot request documents; Ashdale does that.

> [!note] Halden, 30 May
> We asked for a revised release record. Before we accept one, we should be clear what would make it different from the old one other than the name of a machine. A record that is reissued to answer a question tends to answer it.
>
> Hesper: Agreed. We compare the traces line by line when it arrives.
