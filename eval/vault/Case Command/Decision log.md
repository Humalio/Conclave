---
owner: Case Command
status: active
depends_on: ["[[Case charter]]"]
tags: [case-command, decisions]
---

# Decision log

Every case-level decision, in order of ID. IDs D-001 to D-003 were reserved when the log was opened in January, so their dates are the dates the decisions were actually taken and do not run in sequence. One line of decision, one line of rationale, who decided. Case Command keeps the log; the decider signs. Entries are never edited after signature; corrections are new entries.

## How to use this log

- A decision is anything that changes scope, schedule, a requirement, a capture limit or a baseline.
- Cite the decision ID (D-nnn) in any note that relies on it.
- If the rationale cannot be written here, write why it cannot, and where it lives.

## Decisions

| ID | Date | Decision | Rationale | Decided by |
|---|---|---|---|---|
| D-001 | 6 Jan | Charter revision C issued | Relay clocks split out as their own subsystem; Disclosure Board independence clause | I. Calloway |
| D-002 | 24 Mar | Firmware build 7 baselined as the cause line; [[Q-9 quiet receiver]] retained as backup | Build 7 already on all forty relays; Q-9 is 11 % less sensitive and costs a dish rebuild; R8 mass budget | Hesper, approved I. Calloway |
| D-003 | 2 Dec 2190 | Run captures on the Tern-9 test stand, not on Corvel | The echo has only ever been logged at Tern-9; a bench copy on Corvel never rang | Orla, Brannoc |
| D-004 | 14 Feb | Dish panel 7 left in place after the refit survey; no purchase order found, recorded as "stores issue" | Replacing it costs eleven days of dish time; panel already certified relay grade | Dunmore |
| D-005 | 4 Mar | **Cap all transmissions at power 0.30** | █████ █████ █████████ ███ █████ ██ ███ ██████ █████[^1] | I. Calloway |
| D-006 | 4 Mar | Live-listen campaign paused, including LL-05; CAP-016 page 3 withheld from circulation | █████████ ██████[^1] | I. Calloway |
| D-007 | 21 Mar | Clock jitter closed as a cause of the echo 47 timing | [[CAP-011 Clock holdover]]: jitter < 0.3 ns; the echo itself stays open | Calder |
| D-008 | 10 Apr | Frost specimen F-3 retained at 35 K in a sealed cell, not destroyed | Unknown material; destruction would remove evidence; see [[IR-0412 Tern-9 cryo alarm]] | Ayo, Orla; approved I. Calloway |
| D-009 | 20 Apr | CAP-014 transmissions 201–800 sent at power 0.33 | "Per the echo model update (pending)". Exception to D-005. | I. Calloway |
| D-010 | 23 Apr | R12 and hazard H-12 added | "No uncharacterised biological material in the relay loop" | Marguerite, Saoirse |
| D-011 | 6 May | CAP-014b Empty dish authorised: frost scraped, dish face sterilised | Separate the echo from the frost (Xenobiology request) | Hesper, Ayo |
| D-012 | 28 May | Blocker B-01 opened against Pellam build lot B7-L07; release-notes query sent to Pellam | Traceability gap in the build 7 release notes | Hesper |

[^1]: Redacted under [[Do not circulate - echo 47]].

## Pending (no decision yet)

| Item | Waiting on | Raised |
|---|---|---|
| Lift or keep the 0.30 power cap | Director | 7 Mar (Case Command), 2 Apr (Timekeepers), 30 May (Case Command again) |
| Replace build 7 receivers with Q-9 across the Net | CAP-014 result, read out after transmission 800; [[B-01 Firmware 7 fault]] | 28 May |
| Ethics review of wiring the frost into the clock loop | Disclosure Board | 22 Apr, see [[Ethics question - a living sensor]] |
| Charter revision D | Director's signature | 23 Apr |

## Case Command's note on D-005 and D-009

The log is supposed to make decisions legible. Two of them are not. D-005 caps every transmission at power 0.30 for reasons nobody outside the Director's office can read. Seven weeks later, D-009 sends CAP-014 to 0.33 on the strength of an echo model that does not yet exist.

Both may be right. Case Command records, without comment, that the threshold Imani keeps circling in her notebook is 0.32, and that 0.33 is above it.

See [[Echo 47 (why we stopped)]] for the echo that started all of this.
