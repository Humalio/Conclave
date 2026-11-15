---
owner: Relay Engineering
status: active
depends_on: ["[[Capacitor bank]]", "[[Surge protection]]", "[[Relay clock design]]"]
tags: [sequence, operations]
---

# Transmit sequence

The scripted sequence from "bank full" to "message sent". Owner: Kemi, with Timekeepers for the send command. Revision 4, 20 May 2191.

## Sequence

Times are relative to the commanded send, T0.

| Step | Time | Action | Gate to proceed |
|---|---|---|---|
| S1 | T−20 min | Bank recharge complete | 2.10 GJ, all strings healthy |
| S2 | T−5 min | Cryo hold check | receivers ≤ 18.2 K, shroud 40 ± 1 K |
| S3 | T−3 min | Keepers in shielded bunks, hatches sealed | Xenobiology go |
| S4 | T−120 s | Surge detection armed, crowbar armed | self-test pass |
| S5 | T−101 s | Amplifier on, ramp start | none |
| S6 | T−101 → T−11 s | Ramp to the commanded power (90 s) | feed taps balanced |
| S7 | T−11 s | Hold at commanded power | relay clock locked |
| S8 | T0 | **Send** on relay clock command | none |
| S9 | T0 + 40 ms | Amplifier output zero, energy in dump | dump temp logged |
| S10 | T0 + 6 min | Dump cooled; sequence closed | none |

## Who owns the send

The [[Relay clock design]] issues the send command, not this sequence. The sequence hands control to the clock at S7 and takes it back at S9. The clock must time the send within 4 ns; Timekeepers explain why in [[Lead-time error]]. Our job is to make sure the switches open in the same nanoseconds every time: switch jitter on the prototype is 0.6 ns, which leaves the clock most of the budget.

A reply that lands in the receivers before S8 is, by this sequence, impossible. The relay controller logs one anyway, 0.71 s ahead of T0, above power 0.32.

## Holds and aborts

- Any gate failure before S5: hold, fix, restart from S1 or S2.
- Any failure during S6: controlled ramp-down using the bank reserve, 90 s back to zero. No send.
- Surge at any time: [[Surge protection]] fires; sequence ends.
- Any failure during S7: the [[Shutdown criteria]] apply; abort is an early send at reduced power.

## Test-stand variant

On the test stand in Cold bay 2 the same sequence runs at 1:20 scale with a 30 s ramp. Since 4 March every bench transmission is capped at **power 0.30** by programme instruction; the cap is enforced by a drive limit in the amplifier, set by Kemi and checked by Brannoc before each run. Transmissions are logged in [[Listening log]].

> [!note] Kemi, 2 April
> The listening log for echo 52 says 0.29. The drive limit held, output never went above setpoint, and no send command was logged. I've been asked twice whether a reply could arrive without a transmission to answer. I don't know. That's not a question for this note. See [[Second timestamp]].

## Changes

- Rev 3, 6 Mar: bench cap at power 0.30 added.
- Rev 4, 20 May: S3 keeper step added at Xenobiology's request; ramp start moved from T−100 s to T−101 s to give the clock one clean second of lock before hold.
