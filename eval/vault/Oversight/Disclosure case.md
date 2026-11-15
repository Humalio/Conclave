---
owner: Disclosure Board
status: draft
depends_on: ["[[Power budget]]", "[[Hazard log]]", "[[Firmware 7]]", "[[Exposure limit]]", "[[Lead-time error]]"]
tags: [safety, disclosure, m6]
---

# Disclosure case

Echo Case disclosure case for the Tern-9 dish array and the planned live listen. Revision C (draft), 1 June 2191. Prepared for the Disclosure Board under [[Disclosure basis]] and subject to [[Independent review rules]]. This case supports milestone M6 (disclosure approved, due 31 Jan 2192); it shall not be cited as evidence that the relay is safe to operate before the Board signs it.

## §1 Scope

1.1 This case covers one deliberate live listen at relay Tern-9 and the return listen (requirement R1), at transmit power p ≈ 0.62 held for 11 s.

1.2 It covers the dish feed array, the receiver shield, the power train, the relay clock, the keepers' bunks and the shutdown chain, as installed by the Tern-9 refit team under the [[Refit plan]].

1.3 It does not cover ground testing on the dish test stand, which is governed by the test-stand safety rules, nor any transmission above power 0.65.

1.4 Every claim in this case shall trace to a capture ID (R11). A claim without one is marked **UNSUPPORTED** and shall not be counted toward disclosure.

## §2 System description

2.1 Twelve feed modules sit in a ring behind the dish ([[Dish array design]]). At nominal current 18.4 kA they set a transmit power of 0.62.

2.2 The modules draw from a 2.1 GJ capacitor bank charged in 90 s from the station's reactor ([[Power budget]], [[Capacitor bank]]).

2.3 A cryogenic receiver shield at 40 K keeps the transmitted signal off the quarters and the keepers ([[Shielding interface]]). The timing record the Net relies on has an official explanation, [[Firmware 7]], which this case does not rely on.

2.4 The relay clock stamps every transmission to within 4 ns (R5) ([[Relay clock design]]).

2.5 Four keepers sleep in bunks built to [[Bunk shielding requirements]].

## §3 Hazard identification

3.1 Hazards are identified, ranked and tracked in the [[Hazard log]]. At this revision the log holds H-01 to H-12.

3.2 The log shall be the single source of hazard status. Where this case and the log disagree, the log governs and this case shall be revised.

3.3 H-12 (unidentified biological material) was raised on 23 Apr following [[IR-0412 Tern-9 cryo alarm]]. Its controls are not yet defined; see §8.

## §4 Transmit power

4.1 **Claim.** The dish shall hold transmit power within the [[Power budget]] for 1000 transmissions at operating power without mount crack or loss of cryogenic integrity (R4, H-03).

4.2 **Evidence.** [[CAP-012 Baseline listen]] demonstrates a clean baseline at low power with 2.1× margin on the timestamp scatter limit. The mount qualification stood at 480 / 1000 transmissions with no visible cracks at 1 June; the inspection at 500 is due 3 June.

4.3 **Limitation.** Transmissions 1–500 run at power 0.25. Operating power is 0.62. The mount argument therefore rests on the [[Power budget]] load spectrum, which spans 40–400 Hz. The Board notes that transmissions have been capped at power 0.30 since 4 March and that no mount evidence yet exists above that cap.

4.4 Until transmissions 501–1000 complete, claim 4.1 is **UNSUPPORTED**.

## §5 Signal leak and shielding

5.1 **Claim.** Signal strength in the quarters shall not exceed 2 % of dish-face strength at any point during charge, hold or transmission (H-02).

5.2 **Evidence.** Bench measurements on the 1:20 subscale dish on the test stand; scaling per [[Echo geometry]]. See [[Signal leak hazard]].

5.3 Leak paths through cable penetrations shall be closed per [[Cable routing]] before power-on.

## §6 Timing and lead time

6.1 **Claim.** Lead-time error shall stay inside the pulsar-fix capture window (R6, H-07).

6.2 **Evidence.** [[Lead-time error]] derives its 3σ bound from the [[Clock drift model]] at the 4 ns timing limit, and a tighter bound at the expected 1.9 ns. [[CAP-011 Clock holdover]] confirms holdover jitter below 0.3 ns.

6.3 The Board records that the timing chain logged two entries for one reply on echo 47. This case does not rely on any explanation of that record. The Board shall not accept §6 as closed while an unexplained timing event remains in the evidence base.

## §7 Keeper exposure

7.1 **Claim.** No keeper shall receive more than 3 EH per exposure or 9 EH in any 30 days (R7, H-08), including one corrective listen in each direction.

7.2 **Evidence.** [[Exposure limit]], [[Dose model]], [[Bunk shielding requirements]]. Predicted shielded-bunk exposure for the planned live listen is 2.1 EH.

7.3 Keeper screening per [[Keeper screening]] shall be complete 30 days before M7.

## §8 Residual risk

8.1 Residual risk after controls is tolerable for H-01, H-04, H-05, H-06, H-09, H-10 and H-11, subject to verification.

8.2 Residual risk for H-02, H-03, H-07 and H-08 is **not yet assessed**, pending the evidence named in §4–§7.

8.3 Residual risk for H-12 cannot be assessed: the hazard has no characterised cause. Requirement R12 (no uncharacterised biological material in the relay loop) shall be met by exclusion until the material is characterised.

8.4 The Board shall not sign this case while any claim in §4–§7 is marked UNSUPPORTED.

> [!note] Chair's margin, 1 June
> Eight sections. I keep wanting a ninth and I cannot say what goes in it. — Marguerite
