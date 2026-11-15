---
owner: Timekeepers
status: active
depends_on: ["[[Relay clock design]]"]
tags: [timing, instrumentation]
---

# Timing chain

Every path a timing signal takes in the Tern-9 dish house, from oscillator to log file, with the latency of each hop. Owner: Mirela. The same chain, with shorter cables, is the station design in [[Relay clock design]].

![[timing-chain.svg]]

## The two paths

The timestamp unit (TSU) has two inputs, deliberately independent so that each can check the other.

**Path A: commanded.**

| Hop | Latency | Notes |
|---|---|---|
| Sequencer issues SEND CMD | 0 | Reference point |
| Fibre to trigger | 41.0 ns | Fixed, calibrated |
| Trigger to TSU input A | 3.2 ns | Fixed, calibrated |
| TSU stamps event | — | Resolution 0.1 ns |

**Path B: detected.**

| Hop | Latency | Notes |
|---|---|---|
| Signal crosses the 55 % threshold at the receiver | 0 | Physical event |
| Sample-coupler pickup loop (outside the petal ring, inside the dish house) | < 1 ns | Passive loop |
| Coax to discriminator | 22.6 ns | Replaced 15 Mar, with the DAQ crate; same length |
| Discriminator to TSU input B | 2.8 ns | Fixed |
| TSU stamps event | — | Resolution 0.1 ns |

On a normal record, input B fires 412 ± 3 µs *after* input A: that is the group delay of the receive filter chain between the command and the loopback tone crossing 55 %. Mirela calls it "the honest gap". It is always positive. It has been positive on every record but one.

## The power samples

Path B does a second job. The discriminator also digitises the pickup-loop signal at 1 kHz and converts it to a transmit power estimate. These samples are written to the **raw timing record** with the TSU events.

A separate logger reads the same samples and writes the **summary log**: a 1 s boxcar average of power, one line per second. The summary log is what the keepers read during a send, what the [[Listening log]] quotes, and what most reports cite. The raw record is kept, compressed, and rarely opened.

A 1 s average can hide a short event entirely. A 40 ms excursion of 0.07 in power moves a 1 s average by 0.0028, below the summary log's two-decimal display. This is not a fault. It is what averages are for. It is also how echo 52's spike was missed for a day; see [[Second timestamp]].

## Other clocks in the building

| Instrument | Clock | Sync to relay clock |
|---|---|---|
| Dish-house DAQ crate (strain, temperature, drive current) | Own 10 MHz, disciplined | ±1 µs |
| Dish-house microphone | Audio interface, 48 kHz | ±50 µs, by sync tone at the start of the window |
| Cryo plant alarm system | Plant controller | ±5 ms |
| Sensor recording (live-listen files) | DAQ crate | ±1 µs; see [[Recording notes]] |

These clocks are independent hardware. A fault in one cannot shift the others. That is why it is significant that the clock, the microphone and, on 9 April, the cryo alarm log ([[IR-0412 Tern-9 cryo alarm]]) have each recorded something 0.7 s ahead of its cause.

## Calibration

Path latencies are checked monthly by injecting a test edge at the pickup loop and the sequencer simultaneously. Last calibration 28 May: path A 44.2 ns, path B 25.4 ns, both within 0.1 ns of nominal.

> [!note] Mirela
> The chain is calibrated to a tenth of a nanosecond. On echo 47 it recorded an event 710 million nanoseconds early, in the right channel, with the right shape. I have stopped asking whether the chain is broken. I have started asking what it is measuring.
