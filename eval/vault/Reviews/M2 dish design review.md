---
owner: Relay Engineering
status: draft
depends_on: ["[[Dish array design]]", "[[Power budget]]", "[[Surge protection]]", "[[Firmware 7]]"]
tags: [reviews, m2, dish]
---

# M2 dish design review

Review package for milestone M2, *Dish design review*. Scheduled 8 July 2191, Corvel Station, Annex conference room, with Tern-9 on the link. M2 due 15 July. Package prepared by Brannoc (Relay Engineering); chair Hollis (Disclosure Board); independent reviewers from the Annex per [[Independent review rules]]. **Draft. Not yet issued.** Issue date: 1 July.

## Purpose

To decide whether the Tern-9 dish array design is mature enough to release for the rebuild. A pass releases the panel order and the [[Feed horn spec]] to the refit contractor; a fail costs about six weeks.

## Items under review

| # | Item | Note | Evidence | Ready? |
|---|---|---|---|---|
| 1 | Dish geometry and beam shape | [[Dish array design]] | Echo model v1 | Partial: depends on M1 freeze, due 30 Jun |
| 2 | Feed power, margin, conductor | [[Dish array design]] | 18.4 kA nominal; 16.7 % margin | Yes |
| 3 | Surge detection and dump | [[Surge protection]] | [[CAP-009 Dish surge]] | Yes |
| 4 | Power train and bank | [[Power budget]], [[Capacitor bank]] | 2.1 GJ, 90 s charge | Yes |
| 5 | Transmit timing | [[Transmit sequence]] | Tern-9 service passes | Yes |
| 6 | Receiver interface | [[Shielding interface]], [[Firmware 7]] | CAP-014 running, result pending | **No**: depends on M3 evidence |
| 7 | Cryogenic load | [[Cryo plant]] | [[dish-thermal.csv]] | Yes |

## Entry criteria

- M1 echo model frozen (due 30 June). If M1 slips, item 1 is reviewed against v1 with a carried action.
- CAP-014 block B complete and the hand-clocked tape read out.
- All Relay Engineering notes above at status active or frozen.
- [[Review checklist]] complete.

## Questions the reviewers have already sent

1. **The Annex (Halden):** The dish design assumes build 7 receivers and a firmware patch. If Q-9 replaces them, does the array still close? Please show the sensitivity to a heavier, shielded front end.
2. **Disclosure Board (Hollis):** On echo 47 the reply was logged 0.71 s before the send at power 0.34. Please explain the dish's behaviour on that transmission, or state that it is not explained.
3. **The Annex (Vesna):** The receiver model used for the dish stops at the clock path. Is there any receive content near 2.3 GHz?

## Draft responses (Brannoc)

1. Sensitivity study in hand; array closes with Q-9 at 3 % less margin. Will include.
2. *(Left blank. Talk to Orla.)*
3. "Not in the model." Will expand.

## Risk to the date

Item 6 is the long pole. If CAP-014 confirms Firmware 7, the review can pass with a carried action. If it does not, the rebuild has been designed against the wrong cause, and M2 slips with M3.
