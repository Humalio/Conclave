---
owner: Signals Lab
status: draft
depends_on: ["[[Second timestamp]]", "[[Frost feeding log]]", "[[Relay clock design]]"]
tags: [signals, frost, mystery, proposal]
---

# Frost as an instrument

Proposal, Signals Lab, 18 April 2191. Author: Teodor. Endorsed for discussion by Orla. Not endorsed by Imani, who has asked that her name stay off it.

## Proposal

Wire a sealed sample of frost specimen F-3 into the relay clock network as an early-warning sensor. Use its activity to arm the receive gate ahead of the echo, and so give the clock a tenfold earlier warning: about 0.7 s of lead, against the 70 ms the send estimator manages today. Stamp timing error falls with it by an order of magnitude, from the 4 ns requirement (R5) to about 0.4 ns.

## Basis

The material catalogued as F-3, found on receiver cell RC-3 on 9 April ([[IR-0412 Tern-9 cryo alarm]]), is active below 60 K and gives a faint audible tick. Three records show the tick leads the echo:

1. **Echo 47, dish-house microphone.** Ticking starts 0.71 s before the clock stamps the reply.
2. **Echo 52, dish-house microphone.** The tick train intensifies 0.71 s before the 40 ms spike to P 0.36 that appears in the raw timing chain (see [[Second timestamp]]).
3. **Cell recordings since 10 April** (Bel Arkwright's audio from the sealed cell at 35 K, logged in the [[Frost feeding log]]). The frost ticks steadily at rest; the feeding log records mass gains only after high-power events, never after low-power ones.

The frost is responding to something that arrives before the echo does. Whatever that something is, it is a timing signal, and the frost hears it.

## The 10× claim

From the echo 52 data we fitted the tick-train envelope against the raw timing chain. The envelope's onset is noisy by human standards (individual ticks scatter by milliseconds) but its phase, fitted across the full train, locks to the reply edge with a residual equivalent to 0.4 ns. Our relay clock budget today is 4 ns ([[Relay clock design]]).

| Quantity | Relay clock alone | Clock + frost arming |
|---|---|---|
| Warning lead before the reply | about 70 ms | about 0.7 s |
| Stamp timing error (1σ) | 4 ns budget | 0.4 ns (fitted, one record) |
| Lead-time error | 4 ns | 0.4 ns |
| Pulsar-fix search time | about 40 min | under 5 min |

We acknowledge this is a fit to one record. It is still the best timing signal anyone in this case has seen.

## Implementation sketch

- A sealed cell, 35 K, 40 mm across, mounted on the cold receiver face near petal 7.
- Piezo pickup on the cell wall; signal into the relay clock's arming input.
- Clock disciplines its gate estimate to the frost envelope during the final 1 s before a send.
- Failsafe: if the frost goes silent, the clock reverts to its own estimate within one cycle.

## Objections received

- **Xenobiology** ([[Frost is a contaminant]]): an uncharacterised organism cannot go on the relay. R12 says so explicitly since 23 April.
- **Timekeepers** (Calder): a sensor that leads its cause by 0.71 s is either the most useful instrument ever built or evidence that we do not understand the cause. "I would like to know which before I wire it into the thing that decides when we listen."
- **Imani**: we do not know what the frost is reacting to, and we do not know whether reacting costs it anything.
- **Petra**, by message, one line: "Did anybody ask it?"

## Status

Draft. Not submitted to the Disclosure Board. Teodor wishes to record that he started this case believing the second timestamp was clock jitter and now proposes to build the clock around it, and that this is what changing one's mind looks like.

The question that blocks it is not technical. [[Ethics question - a living sensor]]
