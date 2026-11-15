---
owner: Case Command
status: active
depends_on: []
tags: [test-stand, log]
---
# Listening log

Tern-9 dish test stand. One line per event. Stand time. Kept by the duty keeper; tidied weekly by Wynn. Detail lives in the capture notes; this is the index of what happened when.

Abbrev: Bay 2/3 = receiver bay 2/3. p = transmit power. tx = transmission. LL = live listen. IL = interlock.

## February

```
04 Feb 21:40  tx 31. LL-01. p 0.20. clean.
11 Feb 17:00  CAP-012 baseline kit ready, to The Annex.
14 Feb 15:20  spare tile set T-1 to T-6 recd from Corvel Works. fixture stock rack.
18 Feb 22:05  tx 39. LL-02. p 0.23. clean.
26 Feb 13:30  bay 2 cold fixture rebuilt. new tile set fitted beside dish panel 7.
26 Feb 18:10  bay 2 cooldown. 40.0 K.
```

## March

```
03 Mar 22:12  tx 47. LL-03. target p 0.25.
03 Mar 22:14  p 0.34 for 3.0 s. clock logs reply x2 (06.290, 07.000).
03 Mar 22:14  1.92 kHz line, strain ch. ticking on bay 2 mic.
03 Mar 22:14  intercom power lost 07.4. restored 22:16.
03 Mar 23:05  feed warm-up. no surge. fixture visual OK.
04 Mar 07:50  director's order. IL cap p 0.30 all transmissions. LL-05 postponed.
04 Mar 11:45  IL set 0.30, bay 2. verified Brannoc.
12 Mar        CAP-012 closed. pass.
15 Mar        receiver coax replaced. bay 2 DAQ crate swapped.
17 Mar 09:00  CAP-011 holdover start. timing rack.
21 Mar 16:30  CAP-011 closed. jitter < 0.3 ns.
```

## April

```
02 Apr 20:50  tx 52. characterisation. summary log p 0.29.
02 Apr 21:30  raw timing chain archived. not reviewed.
03 Apr 10:15  raw timing tx 52 pulled by Timekeepers.
09 Apr 03:38  tx 53. night thermal soak. cmd p 0.24.
09 Apr 03:40  bay 2 cryo alarm. pressure transient. IR-0412.
09 Apr 03:41  B. Arkwright on site. fixture settling.
09 Apr 04:20  borescope IP-2. glassy film, tile T-3 cold face. bay 2 held. no entry without Xenobiology.
10 Apr 11:00  film to sealed cell, 35 K. to Xenobiology.
11 Apr 14:00  microscope map. faint film, 9 spots, T-1 to T-6. T-3 thickest. B. Arkwright.
14 Apr        bay 2 fixture cleaned. panel 7 stays (part of the dish frame).
15 Apr 10:30  T-3R mounted, T-3 position.
16 Apr 21:15  tx 55. LL-04. p 0.28. clean.
17 Apr        tx 56-70 begin. short bench characterisation, between CAP-014 blocks. cmd <= p 0.30.
20 Apr 08:30  CAP-014 start. bay 2. p 0.25.
```

## May

```
02 May        CAP-014 tx 100. control clean.
05 May 17:30  waiver W-07: bay 3 only, p 0.33 from tx 101. signed I. Calloway.
06 May 08:00  bay 3 commissioned. face baked 36 h. swabs neg.
06 May 09:10  CAP-014b start. bay 3. p 0.25.
14 May        CAP-014b tx 100. clean.
15 May 16:02  CAP-014b tx 101. p 0.33. early reply. 1.92 kHz line, strain ch.
17 May        CAP-014 tx 150. control clean.
21 May        CAP-014b tx 250. early replies 150 of 150.
27 May 17:20  CAP-014b tx 450. ring nodes, 9 sites. bay 3 hold.
28 May 10:00  B-01 opened, The Annex.
29 May 22:10  tx 70. last of 56-70. all cmd <= p 0.30.
30 May 09:00  raw 1 kHz timing, tx 56-70, reviewed by Timekeepers. excursions > 0.32: tx 58, 63, 67, 70. 18-36 ms each.
```

## June

```
01 Jun 18:00  CAP-014 tx 200. block A complete. no early replies.
01 Jun 18:05  bay 2 IL still 0.30. block B (p 0.33) needs IL change.
```

## Standing notes

- IL cap p 0.30 applies to every transmission on this stand until further order. W-07 is the only exception logged. It covers bay 3.
- Dish panel 7 is part of the dish frame and cannot be swapped without taking the dish down. No date.
- Night duty roster, bay 2 cryo: B. Arkwright. She has asked twice for a second person on nights. Logged here because it was not logged anywhere else.
- Next bay 2 event: CAP-014 transmission 201, the first at p 0.33 on the air-gapped rig.

## Where the detail is

Live listens: [[CAP-016 Live listen]] and [[Echo 47 (why we stopped)]]. Clock: [[CAP-011 Clock holdover]]; echo 52 raw timing: [[Second timestamp]]. Alarm of 9 Apr: [[IR-0412 Tern-9 cryo alarm]]. Captures: [[CAP-014 Air-gapped capture]], [[CAP-014b Empty dish]], [[B-01 Firmware 7 fault]]. Baseline: [[CAP-012 Baseline listen]].
