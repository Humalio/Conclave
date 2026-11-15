---
owner: Disclosure Board
status: active
depends_on: ["[[Disclosure basis]]"]
tags: [safety, review]
---

# Independent review rules

How the Disclosure Board shall review safety-critical work (requirement R10). Adopted 3 February 2191; amended 23 April.

## Principle

1.1 No team shall sign off its own work. A safety-critical item is reviewed by people who did not design it, did not test it and do not report to anyone who did.

1.2 The reviewer's job is to find the claim that is not supported. A review that finds nothing shall say what was checked, so that "nothing found" can be distinguished from "nothing looked at".

## What is safety-critical

2.1 Any item that controls a hazard of severity I or II in the [[Hazard log]].

2.2 Any model whose output is used as evidence in the [[Disclosure case]].

2.3 Any change to a frozen design after its review.

## Who reviews

| Item owned by | Reviewed by | Not by |
|---|---|---|
| Signals Lab | Timekeepers and Disclosure Board | Relay Engineering (shares the dish) |
| Relay Engineering | The Annex and Disclosure Board | Signals Lab |
| The Annex | Relay Engineering and Disclosure Board | Tern-9 Keepers (install it) |
| Timekeepers | Signals Lab and Disclosure Board | — |
| Xenobiology | Disclosure Board, with an outside physician | — |
| Tern-9 Keepers | The Annex and Disclosure Board | — |

3.1 Case Command may chair a review but shall not vote in it.

3.2 The Authority's director shall not attend a safety review as a participant. She may receive the minutes.

## Conduct of a review

4.1 The package shall be issued five working days before the review, checked against the [[Review checklist]].

4.2 Every claim in the package shall carry a capture ID or be marked UNSUPPORTED.

4.3 Findings shall be graded: **major** (blocks the milestone), **minor** (fix before next revision), **observation** (record only).

4.4 Minutes shall be filed within two working days and entered in the [[Review log]].

## Classified material

5.1 Where evidence relevant to a safety-critical item is held under classification, the reviewer shall be told that it exists, though not what it says.

5.2 *Amendment, 23 April:* where a reviewer has reason to think such evidence exists and has not been told, the reviewer shall record that suspicion as an observation.

The amendment was proposed by Hollis after the echo 47 review produced a whiteboard (see [[Whiteboard, 14 March]]) and no minutes.
