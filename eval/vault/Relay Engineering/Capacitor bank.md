---
owner: Relay Engineering
status: active
depends_on: []
tags: [power, bank]
---

# Capacitor bank

The energy store that feeds the transmit amplifier. Owner: Kemi. Revision 3, 16 May 2191.

## Summary

| Parameter | Value |
|---|---|
| Usable energy | **2.1 GJ** |
| Modules | 48 × 43.75 MJ |
| Ramp time, amplifier from bank | **90 s** |
| Recharge, bank from plant | 14 min at 2.5 MW |
| Mass, installed | 61 t |
| Location | below the transmit hall, port and starboard bays |

Tern-9's reactor was sized for four keepers, a cryo plant and a receiver, not for a 23 MW amplifier. So the reactor fills the bank slowly and the bank feeds the amplifier fast. That is the whole idea, and [[Power budget]] carries the numbers.

![[power-flow.svg]]

## Module

Each module is a stack of film capacitors in a sealed can with its own fuse, bleed resistor and switch. Forty-eight modules in eight strings of six. Any one string can be isolated without stopping a ramp, at the cost of 1/8 of the energy.

| Module item | Value |
|---|---|
| Energy | 43.75 MJ |
| Voltage | 4.2 kV |
| Mass | 1.18 t |
| Life | 20,000 full cycles (vendor), 5,000 (our derating) |

Five thousand cycles is far more than a relay will ever ask of it; the derating is for the temperature in the transmit hall, which the keepers describe as "warm, honestly".

## Energy per transmission

Energy scales with transmit power (relative, 0 to 1) and with how long the burst lasts. The design burst is **power 0.62 for 90 s**, which costs 1.71 GJ at the amplifier. A burst at the 0.32 line, the level above which the echo appears, costs about 0.88 GJ. A bench transmission under the 0.30 cap costs under 0.83 GJ and the bank barely notices.

| Transmission | Power | Energy at amplifier | Bank left |
|---|---|---|---|
| Housekeeping beacon | 0.05 | 0.14 GJ | 93 % |
| Bench cap | 0.30 | 0.83 GJ | 60 % |
| Echo line | 0.32 | 0.88 GJ | 58 % |
| Design burst | 0.62 | 1.71 GJ | 19 % |

The amplifier ramps at a constant rate so the feed's surge detection stays simple and the load in [[Signal paths]] stays smooth. The rest of the 2.1 GJ is converter loss, cable loss and the reserve held for a controlled ramp-down if a transmission is aborted.

## Faults

The bank is the second most dangerous thing on the station after the amplifier. Hazard H-04 "bank discharge fault" in the [[Hazard log]] covers it. Design responses:

1. Each module fused; a shorted module blows its fuse and drops out.
2. String isolators rated for full fault current.
3. Crowbar on the main bus, fired by [[Surge protection]] or by the shutdown chain.
4. Bleed resistors take the bank to safe voltage in 20 minutes if everything else fails.

## Status

- Prototype string (6 modules) on the test stand since April; 312 cycles, no faults.
- The test stand in Cold bay 2 uses its own small bank, not this one.
- Order for 48 flight modules placed 16 May; delivery in four lots, the first due 1 August.

> [!note] Kemi
> People ask why 2.1 GJ when the design burst only takes 1.71. Because the day we need to abort a transmission halfway, I want energy left to do it gently. A bank sized exactly to the burst is a bank with no opinion.
