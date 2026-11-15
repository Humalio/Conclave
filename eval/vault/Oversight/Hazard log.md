---
owner: Disclosure Board
status: active
depends_on: ["[[Lead-time error]]", "[[Echo sleep physiology]]", "[[Surge protection]]", "[[Capacitor bank]]", "[[Cryo plant]]"]
tags: [safety, hazards]
---

# Hazard log

Single source of hazard status for the Echo Case. Revision 7, 1 June 2191. Maintained by Ezra for the Disclosure Board. Every entry shall name its cause, its controls and the capture that verifies them (R11). An entry shall not be closed by the team that owns the control (see [[Independent review rules]]).

## Severity and likelihood

Severity: **I** catastrophic (loss of a keeper or the relay), **II** critical (serious injury, major damage), **III** marginal, **IV** negligible. Likelihood: **A** frequent to **E** improbable. Risk class follows the matrix in [[Disclosure basis]]; class 1 is intolerable, class 4 acceptable.

## Register

| ID | Hazard | Principal cause | Sev | Lik | Class | Controls | Verification | Status |
|---|---|---|---|---|---|---|---|---|
| H-01 | Feed surge during charge or hold | Local arcing in a feed module; margin below 15 % | I | D | 2 | Surge margin ≥ 15 % (R3); detection and dump per [[Surge protection]] | [[CAP-009 Dish surge]] | Controlled |
| H-02 | Signal leak into keepers' quarters | Shield or penetration defect | II | D | 2 | Dish shield; sealed penetrations; [[Signal leak hazard]] | Bench leakage survey | Open |
| H-03 | Dish mount failure at full transmit power | Cyclic loading of the mount at 40 K; resonance not in the model | I | C | 1 | 1000-transmission qualification (R4) | [[Dish mount reinforcement]]; live listen series paused | Open |
| H-04 | Capacitor bank discharge fault | Insulation breakdown, switch failure | I | E | 3 | Segmented bank, crowbar per [[Capacitor bank]] | Bank acceptance test | Controlled |
| H-05 | Loss of cryogenic cooling | Cryocooler failure, leak | II | C | 2 | Redundant heads, 40 min ride-through per [[Cryo plant]] | Plant soak test | Controlled |
| H-06 | Loss of relay clock | Oscillator failure, supply loss | I | E | 3 | Dual oscillator, holdover | [[CAP-011 Clock holdover]] | Controlled |
| H-07 | Lead-time error beyond the pulsar-fix capture window | Clock drift over a transmission | I | D | 2 | Timing ≤ 4 ns (R5); lead-time error inside R6; corrective listen | [[Lead-time error]], [[Pulsar-fix procedure]] | Open |
| H-08 | Echo-sleep overdose | Power, duration or bunk beyond model | II | C | 2 | Limit 3 EH per exposure (R7); shielded bunks; [[Echo sleep hazard]] | [[Exposure limit]] | Open |
| H-09 | Shutdown failure | Silence command not executed within 200 ms | I | E | 3 | Hard-wired shutdown per [[Shutdown criteria]] and [[Emergency silence]] | Shutdown chain test | Controlled |
| H-10 | Bunk shielding gap under ring-band load | Shield panel or mount failure | II | D | 3 | [[Bunk shielding requirements]] | Bunk qualification | Open |
| H-11 | Fire in cable runs | Overheated high-current cable | II | D | 3 | Segregation and detection per [[Cable routing]] | Refit inspection | Controlled |
| H-12 | Unidentified biological material | Not characterised | ? | ? | — | Exclusion from the relay loop (R12) | None defined | Open |

## Notes on entries

**H-03.** Likelihood is held at C, not D, because no cycle evidence exists above power 0.30 and operating power is 0.62. Hollis asked on 12 May that the entry say so plainly. It now does.

**H-07.** Linked downstream to [[Exposure limit]]: a lead-time error outside the capture window requires a corrective listen, which adds exposure for every keeper on the dish bay. The 9 EH per 30 days limit is sized to absorb one corrective listen in each direction. If H-07 likelihood rises, H-08 rises with it.

**H-06 / H-07.** The echo 47 timing record contains a reply logged 0.71 s before the send command. [[CAP-011 Clock holdover]] rules out clock jitter at that scale. Neither entry attributes a cause. The Board has asked the Timekeepers for a written disposition; none has been received.

**H-12.** Added 23 Apr after [[IR-0412 Tern-9 cryo alarm]], on a motion by Ayo, seconded by Marguerite. Severity and likelihood are left blank on purpose: a number would imply understanding the Board does not have. The only control is exclusion, and exclusion is only as good as the inventory.

## Change history

- Rev 5, 4 Mar: H-03 likelihood raised to C after high-power transmissions were paused.
- Rev 6, 23 Apr: H-12 added. R12 added to [[Requirements]] the same day.
- Rev 7, 1 Jun: qualification count updated.

The log holds twelve hazards. The Board has been asked twice whether it should hold thirteen. Both times the minute reads "no basis to enter".
