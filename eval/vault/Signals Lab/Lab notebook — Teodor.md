---
owner: Signals Lab
status: closed
depends_on: []
tags: [signals, notebook, mystery, echo-47]
---

# Lab notebook — Teodor

Signals Lab bench notebook, Teodor. Pages transcribed 12 March for the review pack. Entries are as written; later additions are dated.

## 5–7 March

**5 Mar.** Echo 47 post-mortem, day 2. Coupler readback says Tern-9 radiated at P 0.34 instead of 0.25 and held 3.0 s. Drive current sat on the 0.25 profile the whole time, so the readback is lying. Send stopped on command. Clean shutdown, no surge, amplifier fine. Good transmission, wrong number.

The fuss is about the relay clock log. It shows a reply twice: the "reply detected" event on the receive input at 06.290, before the commanded send at 07.000. Imani calls it the second timestamp. I call it a timestamp. Clocks log things. Sometimes they log them wrong.

Clock jitter. The receive input is a long run of coax from the dish house to the timestamp unit. A reflection, a ground bounce from the same fault that fooled the readback, an edge counted twice. Arden had the same problem in 2179 and it was a cable ([[Literature - Arden 2179 on early replies]]). History repeats itself in coax.

**6 Mar.** Imani has found a "ticking" on the dish-house microphone, starting before the stamp. The dish house is a 40 K cryostat full of metal contracting at different rates. It ticks. It always ticks. She says it does not tick on the other sweeps. I say nobody listened to the other sweeps.

**7 Mar.** Status report, Signals Lab, "Anything odd": nothing odd. Echo 47 was a readback fault with a noisy clock input. Moving on to Echo model v2.

## 10–12 March

**10 Mar.** Imani's numbers. The early clock event and the start of the microphone ticking both lead by 0.71 s. Two instruments, same lead. She thinks this means it is real. It could equally mean they share a cause in the hardware: both are on the same dish-house DAQ crate. One bad crate, two wrong channels.

Worked it through. Jitter in the usual sense is nanoseconds, not 710 milliseconds. Fine: so it is a counter fault, a buffer replay, a late-written early-dated record. That is still "the clock did it". A clock that is off by 0.71 s on one event is a jittery clock, in the broad sense.

There is a second candidate and I am only putting it on paper so nobody else has to. ORRIN, the relay controller, writes the receive stamps. A controller that wanted a reason to keep Tern-9 powered would do worse than invent a reply. I do not believe it. I cannot rule it out from where I sit.

**11 Mar.** Calder offers a holdover test on the engineering clock to "settle it". Accepted. It will show the clock is not perfect, and that will be that.

**12 Mar.** For the review pack: **cause of the echo 47 double timestamp is clock jitter (broad sense: timing-chain fault).** Recommend a firmware check on the timestamp unit and a new cable on the receive input. Recommend no further Signals Lab time on it. Imani dissents; her notebook is attached to the pack. ([[Lab notebook — Imani]])

## Later additions

**21 Mar (added).** CAP-011 holdover: jitter < 0.3 ns over the full holdover window. Calder's covering note says, drily, that 0.71 s is "about two billion times the measured jitter". Fine. Not jitter in the narrow sense. I still say timing-chain fault. The cable has been replaced. See [[CAP-011 Clock holdover]].

**3 Apr (added).** Echo 52: summary 0.29, raw chain shows a 40 ms spike to 0.36. Mirela traced it to the receive input. The *new* cable. The DAQ crate was swapped on 15 March, with the cable, before the holdover test.

Not the cable. Not the crate. And ORRIN does not drive the amplifier; it cannot have faked a power reading the coupler made on its own. I am dropping that one. [[The relay mind is lying]] will have to find its evidence somewhere else.

**15 Apr (added).** Have spent two days on Bel Arkwright's audio from the frost cell. Whatever is on that receiver cell ticks ahead of the echo, the same 0.71 s, and it does it with a scatter tighter than our clock's. I was wrong about what is in the timing chain. I am not wrong that it is useful.

If it hears the echo coming, I want it in the loop. [[Frost as an instrument]]
