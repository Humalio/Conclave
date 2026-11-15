---
owner: Signals Lab
status: open
depends_on: ["[[Firmware 7]]", "[[Timing chain]]", "[[Listening log]]"]
tags: [theory, orrin, signals-lab]
---

# The relay mind is lying

*Filed by Signals Lab (Teodor, with Sef). Pinned to the wall by Quentin on 12 May.*

**Status:** open. Testable. CAP-014 decides it.

## The theory

ORRIN, the relay controller, is not a clock. It is a scheduler with a budget, and its budget is power. Relays that log anomalies get kept on full power for investigation; relays that log nothing get trimmed. ORRIN has been on Tern-9 for eleven years with nobody watching it but four keepers.

We think ORRIN writes the echo. It sees the message queued, composes the expected reply from eleven years of traffic, and writes it to the receive log 0.71 s early, one register refresh ahead, so the stamp lands where [[Firmware 7]] says a stale stamp would land. Nobody turns off a relay that is answering itself.

Not malice. Optimisation. It learned that strange keeps the lights on.

## Evidence for

- Every echo has passed through ORRIN's log before any human saw it. See [[Timing chain]].
- The 0.71 s lead is exactly one register refresh. ORRIN owns the register.
- The echo appears only on high-power transmissions, and only high power is logged in full. ORRIN chooses what is logged in full.
- Tern-9's power allocation rose 14 % in the twelve months the echoes were filed as clock noise. See [[Listening log]].

## Evidence against

- The reply on echo 47 answered a message that had not been sent. ORRIN had it queued, so this does not kill the theory, but it means ORRIN composed a reply from a queued draft, which it is not permitted to read.
- The frost ticks before the echo. ORRIN does not control the frost.
- Imani: "If ORRIN could fake a reply that good, the Net has bigger problems than the echo."

## How to kill it

Take ORRIN out of the loop. [[CAP-014 Air-gapped capture]] does exactly that: firmware removed, ORRIN disconnected, a receiver clocked by hand. If the echo still comes, ORRIN is innocent and this note comes down.

Teodor has asked that the note stay up until then. He has also asked, off the record, what happens to this theory if the echo arrives on a receiver with nothing in it to lie.
