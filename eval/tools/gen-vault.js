// Generates the eval vault. Exports { notes: {path: content}, binaries: {path: Buffer} }
const N = {};
const n = (p, c) => { if (N[p]) throw new Error('dup ' + p); N[p] = c.replace(/^\n/, ''); };
const L = (s) => `[[${s}]]`;

// ---------- hubs ----------
n('Home.md', `
---
tags: [moc, hub]
aliases: [Index, Start here]
---
# Home

Map of content for the Halden Instruments vault. We build [[Brisa]], an indoor air-quality monitor, plus the [[Project Atlas|Atlas]] cloud and the [[Project Kite]] mobile app.

## Product
- [[Brisa]] and [[Brisa Mini]] — see [[Product Lines]]
- Specs: [[Brisa Hardware Spec]], [[Brisa Firmware Spec]], [[Cloud API Spec]], [[Sensor Requirements]], [[Mobile App Requirements]]
- Design: [[Power Design]], [[Enclosure Design]], [[Cloud Architecture]], [[Mobile App Design]], [[OTA Design]], [[Display Design]]

## Plans
- [[Roadmap 2027]] · [[Launch Plan]] · [[Manufacturing Plan]] · [[Test Plan]] · [[Certification Plan]] · [[Support Readiness Plan]]
- Compliance status lives in the [[Compliance Matrix]] (not written yet).

## Operations
- Runbooks: [[Battery Replacement]], [[OTA Rollout]], [[RMA Process]], [[Incident Response]], [[Factory Line Setup]], [[Sensor Calibration]]
- Support: [[Support FAQ]], [[Troubleshooting]], [[Warranty FAQ]], [[Support Macros]]

## Commercial
- [[Price List|Prices]] · [[Sales Playbook]] · [[Pitch Notes]] · [[Competitor Notes]]
- Customers: [[Northwind Schools]], [[Helio Clinics]], [[Ostra Offices]], [[Lumen Coworking]]

## Company
- [[Org Chart]] · [[Glossary]] · Policies: [[Warranty Policy]], [[Data Retention Policy]], [[Privacy Policy]], [[Security Policy]], [[Travel Policy]], [[Expense Policy]], [[Returns Policy]]
`);

n('Glossary.md', `
---
tags: [glossary, hub]
aliases: [Terms, Definitions]
owner: "[[Lena Fischer]]"
updated: 2026-10-01
---
# Glossary

Shared vocabulary. Link to a heading, e.g. \`[[Glossary#MOQ]]\`.

## AQI
Air Quality Index. Brisa shows a simplified three-colour status rather than a numeric AQI.

## CO2
Carbon dioxide, measured in ppm by the [[NDIR-C8 CO2 Sensor]]. Above 1,400 ppm the status turns red.

## PM2.5
Fine particulate matter smaller than 2.5 µm, in µg/m³. A measurement, not a part: do not confuse it with the retired Pintail PM25 sensor.

## Sampling interval
How often the device takes a reading. Default 10 minutes; configurable from 2 to 60 minutes in the app.

## OTA
Over-the-air firmware update. Process in [[OTA Design]] and [[OTA Rollout]].

## Soak period
Time a firmware stage runs before the next stage starts: 24 hours between OTA stages.

## RMA
Return Merchandise Authorisation. See [[RMA Process]].

## Cloud Plus
Paid cloud tier: longer history, CSV export, alerts. Priced in the [[Price List]].

## MOQ
Minimum order quantity a supplier accepts per purchase order.

## EVT / DVT / PVT
Engineering, design and production validation builds.

## Warranty
Manufacturer cover for defects. Terms in [[Warranty Policy]].
`);

// ---------- products ----------
n('Products/Brisa.md', `
---
tags: [product, brisa]
aliases: [Brisa One, BR-100]
owner: "[[Lena Fischer]]"
status: in-development
---
# Brisa

Battery-powered indoor air-quality monitor for classrooms, clinics and offices. Marketing name: **Brisa One**. SKU BR-100.

## What it measures
CO2, PM1.0/PM2.5/PM10, temperature and humidity. A 2.9" e-ink screen shows a green/amber/red status.

## Documents
- [[Brisa Hardware Spec]] · [[Brisa Firmware Spec]] · [[Cloud API Spec]]
- Datasheet: ![[Brisa Datasheet.pdf]]

## Family
See [[Product Lines]]. The smaller sibling is the [[Brisa Mini]]; a future [[Brisa Pro]] is being scoped.
`);

n('Products/Brisa Mini.md', `
---
tags: [product, brisa-mini]
aliases: [BR-50, Mini]
owner: "[[Lena Fischer]]"
status: in-development
updated: 2026-03-01
---
# Brisa Mini

Entry model, SKU BR-50. Measures CO2, temperature and humidity only; no particulate sensor.

## Power
Runs on 2 × AA lithium cells, about 12 months of battery life at the default interval.

## Price
List price €119, positioned for homes and small offices.

## Differences from Brisa
- No PM sensor, no USB-C charging
- Smaller 1.5" e-ink screen
- Same cloud and app ([[Project Kite]])
`);

n('Products/Product Lines.md', `
# Product Lines

| Product | SKU | Status | Notes |
|---|---|---|---|
| [[Brisa]] | BR-100 | launch 2027 | flagship |
| [[Brisa Mini]] | BR-50 | launch 2027 | CO2 only |
| [[Brisa Pro]] | BR-200 | scoping | outdoor, solar |

Brisa and Brisa Mini share the cloud ([[Project Atlas]]) and the app ([[Project Kite]]). The Mini is not a cut-down Brisa board; it has its own PCB.
`);

// ---------- specs ----------
n('Specs/Brisa Hardware Spec.md', `
---
tags: [spec, hardware, brisa]
aliases: [HW Spec, BR-100 spec]
owner: "[[Marta Okafor]]"
status: approved
version: 1.4
updated: 2026-09-02
depends_on: ["[[Sensor Requirements]]", "[[Voltera VC-18 Cell]]"]
---
# Brisa Hardware Spec

## Overview
Hardware definition of the BR-100 ([[Brisa]]). Board photo: ![[brisa-board.png]]

## Sensors
- Particulate: [[KS-PM40 Sensor]] (PM1.0 / PM2.5 / PM10)
- CO2: [[NDIR-C8 CO2 Sensor]]
- Temperature and humidity: on-board SHT-class sensor

## Power
- Battery: 1 × [[Voltera VC-18 Cell]] (3,400 mAh)
- Battery life: 18 months at the default 10-minute sampling interval.
- Charging: USB-C, 5 V / 1 A, full charge in about 4 hours.

## Environmental
- Operating range: 0–50 °C, 10–90 % RH non-condensing.
- Ingress: IP20, indoor use only.

## Display
2.9" e-ink, partial refresh. See [[Display Design]].

## Connectivity
Wi-Fi 2.4 GHz. BLE is used for setup only ([[2026-07-08 Drop BLE mesh]]).
`);

n('Specs/Brisa Firmware Spec.md', `
---
tags: [spec, firmware, brisa]
owner: "[[Priya Raman]]"
status: approved
updated: 2026-09-20
depends_on: ["[[Brisa Hardware Spec]]", "[[OTA Design]]"]
---
# Brisa Firmware Spec

## Sampling
The firmware wakes at the [[Glossary#Sampling interval|sampling interval]] (default interval of 10 minutes), powers the PM fan for 8 seconds, reads all sensors and goes back to deep sleep.

## Display updates
Partial refresh on every sample, full refresh every 12 hours to clear ghosting. Driver work is tracked in [[Project Lumen]].

## Connectivity
Readings are buffered (up to 7 days) and uploaded every hour to the [[Project Atlas|Atlas API]].

## OTA
![[OTA Design#Rollout stages]]

## Power states
Deep sleep 9 µA; sampling peak 180 mA for 8 s; Wi-Fi upload peak 240 mA.
`);

n('Specs/Cloud API Spec.md', `
---
tags: [spec, cloud, api]
owner: "[[Tomasz Nowak]]"
status: approved
updated: 2026-08-10
depends_on: ["[[Data Retention Policy]]"]
---
# Cloud API Spec

Public REST API of [[Project Atlas]]. Base URL \`https://api.halden.example/v1\`.

## Auth
OAuth 2 client credentials for integrations; device tokens for uploads.

## Readings endpoint
\`GET /v1/devices/{id}/readings?from=&to=\`. Requests for raw readings older than 90 days return \`410 Gone\`; use \`/aggregates\` instead.

## Aggregates endpoint
\`GET /v1/devices/{id}/aggregates?resolution=hour\`. Hourly data is available for 2 years (5 years with Cloud Plus).

## Rate limits
600 requests per minute per organisation.
`);

n('Specs/Sensor Requirements.md', `
---
tags: [spec, sensors]
owner: "[[Marta Okafor]]"
status: approved
updated: 2026-05-15
---
# Sensor Requirements

## Particulate
- Must report PM2.5 with ±10 µg/m³ accuracy below 100 µg/m³
- Fan life ≥ 5 years at a 10-minute duty cycle
- Selected part: [[KS-PM40 sensor]] (lowercase link on purpose)

## CO2
- NDIR, ±50 ppm ±5 %; self-calibration over 7 days

## Temperature / humidity
- ±0.3 °C, ±3 % RH
`);

n('Specs/Mobile App Requirements.md', `
---
tags: [spec, mobile]
owner: "[[Lena Fischer]]"
status: draft
---
# Mobile App Requirements

## Must have
- Pair a device over BLE, then hand off to Wi-Fi
- Live status and 24-hour chart
- Push alert when CO2 stays red for 30 minutes

## Should have
- Room groups for schools
- Cloud Plus upsell for long history

Design in [[Mobile App Design]]; project [[Project Kite]].
`);

// ---------- design ----------
n('Design/Power Design.md', `
---
tags: [design, hardware, power]
owner: "[[Marta Okafor]]"
status: approved
updated: 2026-09-10
depends_on: ["[[Brisa Hardware Spec]]", "[[Voltera VC-18 Cell]]"]
---
# Power Design

## Budget
The design targets the 18 months of battery life set in [[Brisa Hardware Spec#Power]]. With one 3,400 mAh 18650 cell and an average system draw of 0.25 mA, the cell lasts about 13,600 hours, roughly 18.6 months, leaving a small margin.

## Sleep strategy
The MCU sleeps between samples. The PM sensor fan only runs during the 8-second measurement window. Wi-Fi joins once an hour to upload the buffer.

## Charging
Linear charger, 1 A max, charge disabled below 0 °C and above 45 °C cell temperature.

## Open issues
- Capacity loss below 5 °C not yet characterised, see [[Test Plan#Battery tests]].
`);

n('Design/Enclosure Design.md', `
---
tags: [design, hardware, enclosure]
owner: "[[Hana Sato]]"
status: in-review
updated: 2026-10-12
depends_on: ["[[Brisa Hardware Spec]]"]
---
# Enclosure Design

Two-part PC/ABS shell from [[Moldwright Plastics]]. Reviewed by the Head of Hardware on 2026-10-20.

## Airflow
Side inlet, rear outlet; the PM sensor sits in a sealed duct so fan air does not mix with the CO2 chamber.

## Thermal
Chamber tests on EVT2 units ([[Test Plan#Thermal tests]]) showed the e-ink display ghosting above 45 °C, so the enclosure is only rated to 45 °C until the DVT re-test.

## Mounting
Keyhole slots for the wall mount kit; desk stand optional.
`);

n('Design/Cloud Architecture.md', `
---
tags: [design, cloud]
owner: "[[Tomasz Nowak]]"
status: approved
updated: 2026-04-01
depends_on: ["[[Cloud API Spec]]"]
---
# Cloud Architecture

The [[Project Atlas]] backend: ingestion, storage, API and alerting.

## Ingestion
Devices upload hourly batches over HTTPS to the ingest service, which validates device tokens and writes to a queue.

## Storage
Readings land in a time-series store partitioned by organisation. Raw readings are purged after 30 days by a nightly job; hourly rollups are kept for two years.

## Alerting
Rules evaluated every 5 minutes; notifications via push, email and webhook.

## Regions
Single EU region (Frankfurt) at launch.
`);

n('Design/Mobile App Design.md', `
---
tags: [design, mobile]
owner: "[[David Osei]]"
status: in-review
updated: 2026-10-05
depends_on: ["[[Mobile App Requirements]]", "[[Cloud API Spec]]"]
---
# Mobile App Design

## Onboarding
Scan the QR code, pair over BLE, choose Wi-Fi, name the room.

## Settings
The sampling slider defaults to 10 min and allows 2–60 min. A warning explains the battery cost of short intervals.

## Upsell
History beyond 7 days shows a Cloud Plus banner: "Keep 5 years of history for €4/month".

## Design system
Uses the [[Brand Guidelines]] colours for the status ring.
`);

const otaPara = 'Releases go out in three stages: 5% of the fleet, then 25%, then 100%. Each stage soaks for 24 hours; the rollout halts automatically if the crash rate exceeds 0.5% or more than 2% of devices fail to check in.';
n('Design/OTA Design.md', `
---
tags: [design, firmware, ota]
owner: "[[Priya Raman]]"
status: approved
updated: 2026-08-28
---
# OTA Design

## Image format
Signed A/B images; the bootloader falls back to the previous slot after three failed boots.

## Rollout stages
${otaPara}

## Signing
Ed25519 keys held in the release HSM; see [[Security Policy#Key management]].
`);

n('Design/Display Design.md', `
---
tags: [design, display]
owner: "[[Hana Sato]]"
status: approved
---
# Display Design

2.9" e-ink from [[Inkline Displays]]. Large status word (GOOD / FAIR / POOR), CO2 value, small PM2.5 and temperature row.

## Refresh
Partial refresh per sample; full refresh twice a day. Ghosting increases with heat, see [[Enclosure Design#Thermal]].
`);

// ---------- plans ----------
n('Plans/Roadmap 2027.md', `
---
tags: [plan, roadmap]
owner: "[[Lena Fischer]]"
status: current
updated: 2026-09-30
---
# Roadmap 2027

## Milestones
| Milestone | Date |
|---|---|
| Design freeze | 2026-11-20 |
| CE/FCC submission | 2027-01-15 |
| Pilot production (500 units) | 2027-02-01 |
| Public launch | 2027-03-15 |
| [[Brisa Pro]] scoping | 2027 Q3 |

## Themes
- Ship Brisa and Brisa Mini together
- Cloud Plus revenue from month one
- Supersedes the [[Old Roadmap 2026]].
`);

n('Plans/Launch Plan.md', `
---
tags: [plan, launch]
owner: "[[Chloe Martin]]"
status: current
updated: 2026-10-10
depends_on: ["[[Roadmap 2027]]", "[[Price List]]"]
---
# Launch Plan

## Date
Launch day is 15 March 2027. Press embargo lifts at 09:00 CET.

## Channels
Direct web shop, education distributors, two healthcare resellers. See [[Launch Messaging]] and [[Press Release Draft]].

## Logistics
Finished units ship from the contract manufacturer to the [[Atlas Logistics]] warehouse in Rotterdam; Atlas handles last-mile delivery to customers.

## Readiness
Support readiness is tracked in [[Support Readiness Plan]].
`);

n('Plans/Manufacturing Plan.md', `
---
tags: [plan, manufacturing]
owner: "[[Oskar Lind]]"
status: current
updated: 2026-10-01
depends_on: ["[[Power Design]]", "[[Enclosure Design]]", "[[Kestrel Sensors]]"]
---
# Manufacturing Plan

## Build partners
PCB assembly at [[Circuitry Partners]], enclosures from [[Moldwright Plastics]], final assembly and test on the Circuitry Partners line in Brno ([[Factory Line Setup]]). BOM export: [[bom-export.csv]].

## Sensor supply
Kestrel requires a 5,000-unit minimum order per batch and quotes twelve weeks lead time, so the first PM40 order must be placed by 2026-11-15 for pilot production. Background: [[2026-06-02 Choose Kestrel PM40#^choice]].

## Cells
[[Voltera VC-18 Cell|Voltera cells]] arrive pre-tested and are shipped at 30–50 % charge for transport.

## Volumes
Pilot 500 units; first production run 5,000 units.
`);

n('Plans/Test Plan.md', `
---
tags: [plan, test, qa]
owner: "[[Alex Kim]]"
status: current
updated: 2026-10-14
depends_on: ["[[Brisa  Hardware Spec]]"]
---
# Test Plan

## Battery tests
Validate the battery-life target in [[Brisa Hardware Spec#Power]] with 20 units in a 20 °C room and 5 units at 5 °C.

## Thermal tests
EVT2 chamber run, 0–55 °C in 5 °C steps. Result: display ghosting from 45 °C. DVT re-test planned for 2026-12.

## Sensor accuracy
Co-location with a reference monitor for 14 days.

## Firmware regression
Nightly on 12 bench units, see [[Release Checklist]].
`);

n('Plans/Certification Plan.md', `
---
tags: [plan, compliance]
owner: "[[Elif Demir]]"
status: current
---
# Certification Plan

## Scope
CE (RED, EMC, LVD), FCC Part 15, UKCA. Lab: TÜV in Munich. Results go into [[EMC Test Report]].

## Timeline
CE submission due 2027-01-15. Pre-scan in December.

## Sign-off
Head of Hardware signs the declaration of conformity.
`);

n('Plans/Support Readiness Plan.md', `
---
tags: [plan, support]
owner: "[[Ines Duarte]]"
status: current
---
# Support Readiness Plan

- Train 4 agents on [[Troubleshooting]] and the [[Support Macros]]
- Publish the [[Support FAQ]] before launch day
- Agree RMA volumes with [[Atlas Logistics]]
- Linked from the [[Launch Plan]] (and links back to it: deliberate cycle)
`);

// ---------- runbooks ----------
n('Runbooks/Battery Replacement.md', `
---
tags: [runbook, support, hardware]
owner: "[[Ines Duarte]]"
status: current
updated: 2026-10-03
depends_on: ["[[Manufacturing Plan]]", "[[Power Design]]"]
---
# Battery Replacement

## When
Expect to replace the cell roughly every year and a half; sooner if the device samples every 2 minutes.

## Steps
1. Remove the device from the wall mount.
2. Undo the four Torx T6 screws on the back.
3. Unclip the cell holder; fit only [[Voltera VC-18 Cell|VC18]] cells from an approved batch.
4. Close, charge for 4 hours, confirm the status screen.

## Disposal
Return used cells to a certified recycler; never ship them with an RMA.
`);

n('Runbooks/OTA Rollout.md', `
---
tags: [runbook, firmware, ota]
owner: "[[Priya Raman]]"
status: current
updated: 2026-09-01
---
# OTA Rollout

## Stages
Releases go out in three stages: 5% of the fleet, then 25%, then 100%. Each stage soaks for 24 hours, and the rollout halts automatically if the crash rate exceeds 0.5% or if more than 2% of devices fail to check in.

## Procedure
1. Tag the build and attach the [[Release Checklist]].
2. Create the rollout in the fleet console.
3. Watch the dashboard during each soak.

## Escalation
If the rollout halts, page Priya Raman (firmware lead) and post in #fw-release.
`);

n('Runbooks/RMA Process.md', `
---
tags: [runbook, support, rma]
owner: "[[Ines Duarte]]"
status: current
updated: 2026-04-22
---
# RMA Process

## Eligibility
Confirm the device is within the 1-year warranty window (check the delivery date in the order system).

## Steps
1. Create the RMA number in the helpdesk.
2. Book a return pickup with [[Atlas Logistics]].
3. On arrival, QA runs the [[Sensor Calibration]] check and a battery test.

## Outcomes
Repair, replace or refund under the [[Returns Policy]].
`);

n('Runbooks/Incident Response.md', `
---
tags: [runbook, ops]
owner: "[[Tomasz Nowak]]"
status: current
---
# Incident Response

## Severity
- SEV1: cloud down or data loss
- SEV2: alerts delayed > 30 min, bad firmware in the field
- SEV3: single customer issue

## Bad firmware
If a bad build is caught at stage 1 (5% of devices), pause it in the console per [[OTA Design#Rollout stages]].

## On-call
Cloud issues → [[Tomasz Nowak]]; firmware issues → [[Priya Raman|Priya]].

## Postmortem
Within 5 working days, blameless, stored in the incident tracker.
`);

n('Runbooks/Factory Line Setup.md', `
---
tags: [runbook, manufacturing]
owner: "[[Oskar Lind]]"
status: draft
---
# Factory Line Setup

## Stations
1. Flash and provision (device token, serial)
2. Sensor check against the golden unit
3. Battery insert and charge to 40 %
4. Final visual and packing

## Golden units
Three calibrated units kept in the line cabinet, re-checked monthly via [[Sensor Calibration]].
`);

n('Runbooks/Sensor Calibration.md', `
---
tags: [runbook, sensors]
owner: "[[Alex Kim]]"
depends_on: ["[[KS-PM40 Sensor]]", "[[NDIR-C8 CO2 Sensor]]"]
---
# Sensor Calibration

## PM check
Compare against the golden unit in the smoke box; pass within ±10 µg/m³ at 35 µg/m³.

## CO2 check
Expose to 400 ppm outdoor air and 1,000 ppm reference gas; pass within ±50 ppm.
`);

// ---------- support ----------
n('Support/Support FAQ.md', `
---
tags: [support, faq]
aliases: [FAQ, Customer FAQ]
owner: "[[Ines Duarte]]"
depends_on: ["[[Battery Replacement]]", "[[Price List]]", "[[Warranty Policy]]"]
status: current
updated: 2026-10-18
---
# Support FAQ

## Buying
**How much does a Brisa cost?** The Brisa costs €249 before VAT (see [[Price List]]). The [[Brisa Mini]] is cheaper but has no PM2.5 sensor.

## Battery
**How long does the battery last?** About 18 months on default settings. Shorter sampling intervals drain it faster. To swap the cell, follow [[Battery Replacement]].

## Reset
**How do I factory-reset a device?** Hold the button on the back for 10 seconds until the screen flashes twice, then release. The device forgets its Wi-Fi network and cloud pairing.

## Environment
**Where can I install it?** Indoors, between 0 and 50 °C, away from direct sunlight and heaters.

## Warranty
Brisa is covered for two years from delivery. See [[Warranty Policy]] for exclusions.

## Data
**How long do you keep my readings?** Raw readings for 90 days, hourly averages for two years ([[Data Retention Policy]]).
`);

n('Support/Troubleshooting.md', `
---
tags: [support]
owner: "[[Ines Duarte]]"
updated: 2026-09-12
---
# Troubleshooting

Customer-facing answers are in the [[support faq]]; this page is for agents.

## Device offline
Check Wi-Fi is 2.4 GHz; 5 GHz-only networks are not supported. Captive portals are not supported.

## Factory reset
Hold the button on the back for 10 seconds until the screen flashes twice, then release. The device forgets its Wi-Fi network and its cloud pairing.

## Readings look wrong
CO2 self-calibrates over 7 days after install. PM readings spike near cooking or candles; that is expected.
`);

n('Support/Warranty FAQ.md', `
---
tags: [support, warranty]
owner: "[[Ines Duarte]]"
status: current
updated: 2026-05-10
---
# Warranty FAQ

## Coverage
Every Brisa ships with a 12-month limited warranty covering manufacturing defects. Batteries are covered for 6 months.

## How to claim
Open a ticket with the serial number and a photo of the label. Support then starts an [[RMA Process|RMA]].

## Not covered
Water damage, drops, opened enclosures, third-party cells.
`);

n('Support/Support Macros.md', `
# Support Macros

## Reset macro
"Please try the 10-second reset: hold the back button until the screen flashes twice."

## Offline macro
"Brisa needs a 2.4 GHz Wi-Fi network. Could you check your router settings?"

## Battery macro
"Battery life depends on the sampling interval; see the FAQ."
`);

// ---------- sales ----------
n('Sales/Price List.md', `
---
tags: [sales, pricing, hub]
aliases: [Pricing, Price Sheet]
owner: "[[Raj Patel]]"
status: current
updated: 2026-10-02
---
# Price List

Single source of truth for list prices. Other notes should link here rather than copy numbers.

## Current prices
| Product | SKU | List price (EUR, ex VAT) |
|---|---|---|
| [[Brisa]] | BR-100 | €249 |
| [[Brisa Mini]] | BR-50 | €129 |
| Wall mount kit | ACC-WM1 | €19 |
| USB-C power adapter | ACC-PSU | €15 |
| Cloud Plus subscription | SUB-CP | €4/month per device |

## Discounts
- Volume: 10% off orders over 100 units of the same SKU.
- Education and healthcare: additional 5%, not combinable with promotions.
- Distributors: see [[Sales Playbook#Channel partners]].

## History
- 2026-10-02: prices held for launch, see [[2026-10-02 Hold price through launch]].
- 2026-04-10: Brisa raised from €229 after the [[KS-PM40 Sensor|PM40]] sensor change.
`);

n('Sales/Sales Playbook.md', `
---
tags: [sales]
owner: "[[Raj Patel]]"
updated: 2026-10-08
---
# Sales Playbook

## Segments
Schools first, then clinics, then offices. Use the [[Pitch Notes]] for first calls and the [[price list]] for numbers.

## Offer
Every unit includes a two-year warranty. Upsell Cloud Plus at €4 a month for organisations that need reports. Orders above 100 units get 10% off.

## Terms
Public schools may pay on 90-day payment terms; everyone else 30 days.

## Channel partners
Distributors get 25% off list; resellers 15%. Contracts via [[Mateo Garcia]].

## Glossary
New reps should read the [[Glossary]].
`);

n('Sales/Pitch Notes.md', `
# Pitch Notes

Rough talking points for first calls.

## Opening
- Classrooms often exceed 1,500 ppm CO2 by noon; that hurts focus.
- Brisa measures CO2, PM2.5, temperature and humidity and shows a traffic-light status on the e-ink screen.

## Price talk
A Brisa retails for 249 euros, and most schools buy enough to qualify for the volume discount. Lead with total cost of ownership: no wiring, battery powered, free cloud tier.

## Objections
- "We already have HVAC sensors": those sit in ducts, not where people breathe.
- "Batteries are a hassle": one charge lasts about a year and a half on default settings.
`);

n('Sales/Competitor Notes.md', `
---
tags: [sales, competitors]
---
# Competitor Notes

## Airthings-style consumer monitors
Cheaper (around €199) but weak fleet management.

## Wired building sensors
€400+ per point plus installation. Our edge: battery, no electrician.

## Brisa Mini positioning
Against €99 consumer CO2 meters; we win on cloud and app.
`);

n('Sales/Quotes/Northwind Quote Q-2026-114.md', `
---
tags: [sales, quote]
customer: "[[Northwind Schools]]"
status: draft
date: 2026-10-21
valid_until: 2026-12-31
---
# Northwind Quote Q-2026-114

Prepared by [[Raj Patel]] for Alex Kim (procurement, Northwind Schools).

| Item | Qty | Unit | Amount |
|---|---|---|---|
| Brisa (BR-100) | 120 | €249 | €29,880 |
| Volume discount 10% | | | −€2,988 |
| Total ex VAT | | | €26,892 |

Delivery: from launch week, 40 units per month.
`);

n('Sales/Quotes/Helio Quote Q-2026-121.md', `
---
tags: [sales, quote]
customer: "[[Helio Clinics]]"
status: draft
date: 2026-10-28
---
# Helio Quote Q-2026-121

| Item | Qty | Unit | Amount |
|---|---|---|---|
| Brisa (BR-100) | 40 | €249 | €9,960 |
| Healthcare discount 5% | | | −€498 |
| Total ex VAT | | | €9,462 |

No volume discount: under 100 units.
`);

// ---------- marketing ----------
n('Marketing/Launch Messaging.md', `
---
tags: [marketing, launch]
owner: "[[Chloe Martin]]"
updated: 2026-10-11
---
# Launch Messaging

## Tagline
Brisa One — clean air you can see.

## Proof points
- Up to 18 months on a single charge
- Set up in two minutes with the app
- Works in any room: no wiring, no electrician

## Audiences
Head teachers, clinic managers, office facility leads.
`);

n('Marketing/Website Copy.md', `
---
tags: [marketing, web]
owner: "[[Chloe Martin]]"
status: draft
---
# Website Copy

## Hero
Brisa One. Clean air for €249.

## Features
- See CO2 and fine dust at a glance
- Battery powered, no wiring
- Free dashboard, Cloud Plus for reports

## Footer
Prices exclude VAT. Two-year warranty.
`);

n('Marketing/Press Release Draft.md', `
---
tags: [marketing, pr]
owner: "[[Chloe Martin]]"
status: draft
---
# Press Release Draft

**Halden Instruments launches Brisa One, the battery-powered air-quality monitor for classrooms**

Brisa One is available from March 15, 2027 through the Halden web shop and education distributors. "Every classroom deserves air you can see," said CEO Jonas Weber.

Contact: press@halden.example
`);

n('Marketing/Brand Guidelines.md', `
# Brand Guidelines

## Colours
Status green #2E9E5B, amber #E8A33D, red #D64545. Background off-white #F7F5F0.

## Voice
Plain, calm, no fear-mongering about pollution.

## Naming
Use "Brisa One" in consumer copy, "Brisa" internally.
`);

// ---------- suppliers ----------
n('Suppliers/Kestrel Sensors.md', `
---
tags: [supplier, sensors]
aliases: [Kestrel]
owner: "[[Oskar Lind]]"
status: active
updated: 2026-06-20
---
# Kestrel Sensors

Supplier of the [[KS-PM40 Sensor]]. Factory in Penang.

## Commercial terms
- MOQ: 5,000 units per order
- Lead time: 12 weeks from PO
- Unit price: €11.80 at 5k volume

## Contacts
Account manager: Wei Lin. Escalation: their VP Sales.

## History
Chosen in [[2026-06-02 Choose Kestrel PM40]].
`);

n('Suppliers/Voltera Cells.md', `
---
tags: [supplier, battery]
aliases: [Voltera]
owner: "[[Oskar Lind]]"
status: active
---
# Voltera Cells

Li-ion cell maker. We buy the [[Voltera VC-18 Cell]]. They also offer the VC-21 (21700 format, 5,000 mAh), which we do not use.

## Terms
MOQ 10,000 cells, lead time 8 weeks, UN38.3 certified.
`);

n('Suppliers/Moldwright Plastics.md', `
---
tags: [supplier, enclosure]
status: active
---
# Moldwright Plastics

Injection moulding for the BR-100 shell ([[Enclosure Design]]). Tool cost €38,000, owned by Halden. T1 samples due 2026-11-25.
`);

n('Suppliers/Atlas Logistics.md', `
---
tags: [supplier, logistics]
aliases: [Atlas]
owner: "[[Sofia Russo]]"
status: active
---
# Atlas Logistics

Third-party logistics provider: warehousing in Rotterdam, last-mile delivery and return pickups. Not related to [[Project Atlas]].

## Contacts
Account manager: Marta Oliveira (marta.oliveira@atlas-log.example).

## Terms
Pick and pack €2.10 per order; returns €6.50 per pickup.
`);

n('Suppliers/Circuitry Partners.md', `
---
tags: [supplier, pcb]
aliases: [CirQ]
status: active
---
# Circuitry Partners

PCB assembly and final assembly line in Brno. See [[Factory Line Setup]].

## Capacity
2,000 units per week on one shift.
`);

n('Suppliers/Inkline Displays.md', `
---
tags: [supplier, display]
status: active
---
# Inkline Displays

Supplier of the 2.9" e-ink panel used in [[Display Design]]. Lead time 10 weeks.
`);

// ---------- parts ----------
n('Parts/KS-PM40 Sensor.md', `
---
tags: [part, sensor]
aliases: [Kestrel PM40, PM40, PM-40 module]
part_number: KS-PM40
supplier: "[[Kestrel Sensors]]"
status: active
---
# KS-PM40 Sensor

Laser-scattering particulate sensor reporting PM1.0, PM2.5 and PM10. Chosen over the Pintail PM25 in [[2026-06-02 Choose Kestrel PM40^choice]].

## Key data
- Range 0–1000 µg/m³; ±10 µg/m³ below 100 µg/m³
- Fan life 8 years continuous
- Supply 5 V, 60 mA active
- Buying: MOQ 5k, about €11.80 each

## Calibration
See [[Sensor Calibration]].
`);

n('Parts/Voltera VC-18 Cell.md', `
---
tags: [part, battery]
aliases: [VC18, Voltera cell]
part_number: VC-18
supplier: "[[Voltera Cells]]"
---
# Voltera VC-18 Cell

## Specs
- Format: 18650 Li-ion
- Capacity: 3,400 mAh nominal
- Unit cost: €2.49 at 10k volume

## Handling
Ship at 30–50 % state of charge. Storage below 35 °C.
`);

n('Parts/NDIR-C8 CO2 Sensor.md', `
---
tags: [part, sensor]
aliases: [C8, NDIR-C8]
---
# NDIR-C8 CO2 Sensor

Dual-channel NDIR CO2 sensor, 400–5,000 ppm, ±50 ppm ±5 %. Used in both [[Brisa]] and [[Brisa Mini]].
`);

n('Parts/Main PCB BR-100-MB.md', `
---
tags: [part, pcb]
---
# Main PCB BR-100-MB

Four-layer board, assembled by [[Circuitry Partners]]. Rev C is the DVT revision.
`);

n('Parts/Enclosure BR-100-ENC.md', `
---
tags: [part, enclosure]
---
# Enclosure BR-100-ENC

Front and back shells, PC/ABS, colour Cloud White. From [[Moldwright Plastics]], designed in [[Enclosure Design]].
`);

n('Parts/E-ink Panel IL-29.md', `
---
tags: [part, display]
aliases: [IL-29]
---
# E-ink Panel IL-29

2.9" 296×128 panel from [[Inkline Displays]].
`);

// ---------- policies ----------
n('Policies/Warranty Policy.md', `
---
tags: [policy, warranty]
owner: "[[Ines Duarte]]"
status: current
updated: 2026-09-14
---
# Warranty Policy

## Term
All Brisa and Brisa Mini devices sold from 2026-09-14 carry a 2-year warranty from the delivery date. The battery cell is covered for 12 months.

## Exclusions
Water damage, physical damage, opened enclosures, non-approved cells.

## Basis
Decided in [[2026-09-14 Extend warranty to 2 years]].
`);

n('Policies/Data Retention Policy.md', `
---
tags: [policy, data, privacy]
owner: "[[Tomasz Nowak]]"
status: current
updated: 2026-08-05
depends_on: ["[[Cloud Architecture]]"]
---
# Data Retention Policy

## Scope
Sensor data and account data held in [[Project Atlas]].

## Retention periods
| Data | Kept for |
|---|---|
| Raw sensor readings | 90 days |
| Hourly aggregates | 2 years |
| Hourly aggregates (Cloud Plus) | 5 years |
| Account data | until account deletion + 30 days |

## Basis
Decided in [[2026-08-05 Raw data retention 90 days]].
`);

n('Policies/Privacy Policy.md', `
---
tags: [policy, privacy]
owner: "[[Elif Demir]]"
status: current
---
# Privacy Policy

## What we collect
Room readings (CO2, particulates, temperature, humidity), device identifiers and account contacts. No audio, no cameras.

## How long
We keep raw readings for three months, then only hourly averages.

## Your rights
Export and deletion from the app or by emailing privacy@halden.example.
`);

n('Policies/Security Policy.md', `
---
tags: [policy, security]
owner: "[[Tomasz Nowak]]"
---
# Security Policy

## Access
SSO with hardware keys for all staff. Production access is time-limited.

## Key management
Firmware signing keys live in the release HSM; two people are needed to sign a release.

## Reviews
Access review every quarter.
`);

n('Policies/Travel Policy.md', `
---
tags: [policy, finance]
owner: "[[Mateo Garcia]]"
---
# Travel Policy

## Booking
Economy for flights under 6 hours. Trains preferred under 4 hours.

## Hotels
Hotel cap €249 per night in major cities, €180 elsewhere.
`);

n('Policies/Expense Policy.md', `
---
tags: [policy, finance]
owner: "[[Mateo Garcia]]"
---
# Expense Policy

## Claims
Submit within 30 days with receipts. Per diems and hotel limits are in [[Travel Policy#Hotels]].

## Approvals
Up to €500 by your manager; above that by [[Mateo Garcia]].
`);

n('Policies/Returns Policy.md', `
---
tags: [policy, support]
owner: "[[Ines Duarte]]"
---
# Returns Policy

## Change of mind
Unopened units can be returned within 30 days for a full refund.

## Faulty units
Handled under the [[Warranty Policy]] via the [[RMA Process]].
`);

// ---------- decisions ----------
const decision = (p, date, title, deciders, ctx, dec, cons) => n(p, `
---
tags: [decision]
status: accepted
date: ${date}
deciders: [${deciders.map(d => `"[[${d}]]"`).join(', ')}]
---
# ${title}

## Context
${ctx}

## Decision
${dec}

## Consequences
${cons}
`);
decision('Decisions/2026-06-02 Choose Kestrel PM40.md', '2026-06-02', 'Choose Kestrel PM40', ['Marta Okafor', 'Oskar Lind'],
  'The Pintail PM25 used in v0 prototypes drifted by 30 % after 3 months in the field ([[Brisa v0 Spec]]).',
  'We will use the Kestrel KS-PM40 for all BR-100 units, replacing the Pintail PM25 used in the v0 prototypes. ^choice',
  'Unit cost rises by about €3; Brisa list price raised from €229. See [[Kestrel Sensors]].');
decision('Decisions/2026-07-08 Drop BLE mesh.md', '2026-07-08', 'Drop BLE mesh', ['Priya Raman'],
  'BLE mesh between devices cost 40 % of the power budget in tests.',
  'BLE is kept for setup only; all data goes over Wi-Fi.',
  'Simpler firmware; schools need Wi-Fi coverage in every room.');
decision('Decisions/2026-08-05 Raw data retention 90 days.md', '2026-08-05', 'Raw data retention 90 days', ['Tomasz Nowak', 'Elif Demir'],
  'Customers asked for three months of raw data for audits; the old 30-day purge was too short.',
  'Raw sensor readings are retained for 90 days. Hourly aggregates stay at 2 years (5 with Cloud Plus).',
  'Storage cost +18 %. Update [[Data Retention Policy]] and the purge job in [[Cloud Architecture]].');
decision('Decisions/2026-09-14 Extend warranty to 2 years.md', '2026-09-14', 'Extend warranty to 2 years', ['Jonas Weber', 'Ines Duarte'],
  'Competitors offer 2 years; EU schools tenders ask for at least 24 months.',
  'All devices sold from 2026-09-14 get a 2-year warranty. Battery cells stay at 12 months.',
  'Update [[Warranty Policy]], the [[Warranty FAQ]] and the [[RMA Process]].');
decision('Decisions/2026-09-30 Keep launch date.md', '2026-09-30', 'Keep launch date', ['Jonas Weber', 'Lena Fischer'],
  'DVT slipped by one week; certification still fits.',
  'The public launch stays on 2027-03-15.',
  'No change to the [[Roadmap 2027]].');
decision('Decisions/2026-10-02 Hold price through launch.md', '2026-10-02', 'Hold price through launch', ['Jonas Weber', 'Raj Patel'],
  'Sensor cost is up but tenders were priced at the current list price.',
  'Brisa stays at €249 and Brisa Mini at €129 until at least three months after launch.',
  'Margin target reduced from 48 % to 45 % for 2027 H1.');
decision('Decisions/2026-05-20 E-ink over LCD.md', '2026-05-20', 'E-ink over LCD', ['Hana Sato', 'Marta Okafor'],
  'LCD backlight made the 18-month battery target impossible.',
  'Use a 2.9" e-ink panel from [[Inkline Displays]].',
  'Slower refresh; ghosting must be managed ([[Display Design]]).');

// ---------- projects ----------
n('Projects/Project Atlas.md', `
---
tags: [project, cloud]
aliases: [Atlas, Atlas backend, Atlas API]
owner: "[[Tomasz Nowak]]"
status: active
---
# Project Atlas

Cloud backend for Brisa devices: ingest, storage, REST API, alerting. Architecture in [[Cloud Architecture]], API in [[Cloud API Spec]].

## Team
[[Tomasz Nowak]] (lead), [[Yuki Tanaka]].

## Milestones
- Beta API: 2026-12-01
- Production: before launch
`);

n('Projects/Project Kite.md', `
---
tags: [project, mobile]
aliases: [Kite, Brisa app]
owner: "[[David Osei]]"
status: active
---
# Project Kite

iOS and Android app for setup and monitoring. Requirements: [[Mobile App Requirements]]; design: [[Mobile App Design]].
`);

n('Projects/Project Lumen.md', `
---
tags: [project, firmware, display]
aliases: [Lumen]
owner: "[[Ben Carter]]"
status: active
---
# Project Lumen

E-ink driver rewrite to cut ghosting and refresh energy by 30 %. Not related to the customer [[Lumen Coworking]].
`);

// ---------- archive ----------
n('Archive/Brisa v0 Spec.md', `
---
tags: [spec, archived]
status: superseded
superseded_by: "[[Brisa Hardware Spec]]"
updated: 2025-11-03
---
# Brisa v0 Spec

Prototype spec. Particulate sensor: Pintail PM25. Battery: 2 × 18650, 9 months life. LCD screen. Target price €199.
`);

n('Archive/Old Roadmap 2026.md', `
---
tags: [plan, archived]
status: superseded
superseded_by: "[[Roadmap 2027]]"
---
# Old Roadmap 2026

Planned launch Q4 2026, single product, LCD display. Replaced after the sensor change.
`);

n('Archive/Pintail PM25 Sensor.md', `
---
tags: [part, archived]
aliases: [Pintail PM25, PM25 sensor]
status: retired
---
# Pintail PM25 Sensor

Retired particulate sensor from the v0 prototypes. Drifted badly; replaced, see [[2026-06-02 Choose Kestrel PM40]].
`);

// ---------- engineering ----------
n('Engineering/Release Checklist.md', `
---
tags: [engineering, firmware]
owner: "[[Ben Carter]]"
---
# Release Checklist

- [ ] Nightly regression green for 3 days ([[Test Plan#Firmware regression]])
- [ ] Changelog written
- [ ] Image signed (two-person rule, [[Security Policy#Key management]])
- [ ] Rollout created per [[OTA Rollout]]
`);

n('Engineering/Coding Standards.md', `
# Coding Standards

- C firmware: MISRA subset, clang-format, no dynamic allocation after boot.
- Cloud: TypeScript strict, every endpoint has a contract test.
- Reviews: one approval, two for security-sensitive code.
`);

n('Engineering/Engineering Onboarding.md', `
---
tags: [engineering, onboarding]
---
# Engineering Onboarding

Week 1: read the [[Glossary]], the [[Brisa Hardware Spec]] and [[Cloud Architecture]]. Get a dev kit from [[Oskar Lind]]. Ask [[Alex Kim]] for bench access.
`);

n('Engineering/Lab Equipment.md', `
# Lab Equipment

- Climate chamber (−20 to 80 °C), booked via the lab calendar
- Smoke box for PM checks
- Reference CO2 monitor, calibrated 2026-07
- 12 bench units on the nightly rig
`);

n('Engineering/Architecture Overview.md', `
---
tags: [engineering, architecture]
---
# Architecture Overview

Device (firmware, [[Brisa Firmware Spec]]) → Wi-Fi → [[Project Atlas]] ingest → time-series store → API → [[Project Kite]] app and web dashboard.

![[Cloud Architecture#Storage]]
`);

// ---------- people ----------
const person = (name, o) => {
  const fmLines = o.nofm ? '' : `---
tags: [person, team/${o.team.toLowerCase()}]
${o.aliases ? `aliases: [${o.aliases.join(', ')}]\n` : ''}team: ${o.team}
${o.manager ? `manager: "[[${o.manager}]]"\n` : ''}---
`;
  n(`People/${name}.md`, `
${fmLines}# ${name}

**Role:** ${o.role}. ${o.manager ? `Reports to [[${o.manager}]].` : ''}

## Responsibilities
${o.resp.map(r => `- ${r}`).join('\n')}

## Contact
- Slack: @${o.handle}
- Based in: ${o.city}
${o.extra ? `\n## Notes\n${o.extra}\n` : ''}`);
};
person('Jonas Weber', { role: 'CEO', team: 'Leadership', aliases: ['J. Weber', 'JW'], handle: 'jonas', city: 'Hamburg', resp: ['Company strategy and fundraising', 'Final say on pricing and launch date'] });
person('Marta Okafor', { role: 'Head of Hardware', team: 'Hardware', aliases: ['M. Okafor', 'Marta O.', 'MO'], manager: 'Jonas Weber', handle: 'marta', city: 'Hamburg', resp: ['Owns the [[Brisa Hardware Spec]] and [[Power Design]]', 'Supplier technical sign-off', 'Hardware hiring'], extra: 'Signs off enclosure and certification documents.' });
person('Priya Raman', { role: 'Firmware Lead', team: 'Firmware', aliases: ['Priya R.', 'priya.raman'], manager: 'Jonas Weber', handle: 'priya', city: 'Berlin', resp: ['Owns [[Brisa Firmware Spec]] and [[OTA Design]]', 'Release approval for firmware'] });
person('Alex Kim', { role: 'QA Engineer', team: 'Hardware', manager: 'Marta Okafor', handle: 'alexk', city: 'Hamburg', resp: ['[[Test Plan]] and the nightly rig', '[[Sensor Calibration]] procedure'], extra: 'Not the same person as the Northwind procurement contact with the same name ([[Alex Kim (Northwind)]]).' });
person('Lena Fischer', { role: 'Product Manager', team: 'Product', manager: 'Jonas Weber', handle: 'lena', city: 'Hamburg', resp: ['[[Roadmap 2027]]', 'Requirements for Brisa and Brisa Mini'] });
person('Tomasz Nowak', { role: 'Cloud Lead', team: 'Cloud', aliases: ['Tomek'], manager: 'Jonas Weber', handle: 'tomasz', city: 'Warsaw', resp: ['[[Project Atlas]]', 'Incident commander for cloud SEV1/SEV2'] });
person('Ines Duarte', { role: 'Support Lead', team: 'Support', manager: 'Lena Fischer', handle: 'ines', city: 'Lisbon', resp: ['[[Support FAQ]] and macros', 'RMA handling', 'Warranty terms'] });
person('Raj Patel', { role: 'Sales Director', team: 'Sales', manager: 'Jonas Weber', handle: 'raj', city: 'London', resp: ['[[Price List]] owner', 'Education and healthcare accounts'] });
person('Hana Sato', { role: 'Industrial Designer', team: 'Hardware', manager: 'Marta Okafor', handle: 'hana', city: 'Hamburg', resp: ['[[Enclosure Design]]', '[[Display Design]] layout'] });
person('Oskar Lind', { role: 'Manufacturing Engineer', team: 'Hardware', manager: 'Marta Okafor', handle: 'oskar', city: 'Brno', resp: ['[[Manufacturing Plan]]', 'Supplier follow-up: Kestrel, Voltera, Moldwright'] });
person('Chloe Martin', { role: 'Marketing Lead', team: 'Marketing', manager: 'Jonas Weber', handle: 'chloe', city: 'Paris', resp: ['[[Launch Plan]] and [[Launch Messaging]]', 'Website and press'] });
person('David Osei', { role: 'Mobile Engineer', team: 'Cloud', manager: 'Tomasz Nowak', handle: 'david', city: 'Accra (remote)', resp: ['[[Project Kite]]'] });
person('Sofia Russo', { role: 'Operations Coordinator', team: 'Operations', manager: 'Mateo Garcia', handle: 'sofia', city: 'Milan', resp: ['Logistics with [[Atlas Logistics]]', 'Spare parts stock'] });
person('Ben Carter', { nofm: true, role: 'Firmware Engineer', team: 'Firmware', manager: 'Priya Raman', handle: 'ben', city: 'Berlin', resp: ['[[Project Lumen]] display driver', '[[Release Checklist]]'] });
person('Yuki Tanaka', { nofm: true, role: 'Cloud Engineer', team: 'Cloud', manager: 'Tomasz Nowak', handle: 'yuki', city: 'Warsaw', resp: ['Ingest service', 'Purge and rollup jobs'] });
person('Elif Demir', { role: 'Compliance Manager', team: 'Operations', manager: 'Jonas Weber', handle: 'elif', city: 'Hamburg', resp: ['[[Certification Plan]]', '[[Privacy Policy]]'] });
person('Mateo Garcia', { role: 'Finance Lead', team: 'Finance', manager: 'Jonas Weber', handle: 'mateo', city: 'Madrid', resp: ['Budget, contracts, [[Travel Policy]] and [[Expense Policy]]'] });
person('Nora Berg', { role: 'People and HR', team: 'People', manager: 'Jonas Weber', handle: 'nora', city: 'Hamburg', resp: ['Hiring, onboarding, reviews'] });

n('People/Org Chart.md', `
---
tags: [people, hub]
updated: 2026-09-01
---
# Org Chart

| Person | Role | Team |
|---|---|---|
| [[Jonas Weber]] | CEO | Leadership |
| [[Marta Okafor\\|Marta]] | Head of Hardware | Hardware |
| [[Priya Raman]] | Firmware Lead | Firmware |
| [[Tomasz Nowak]] | Cloud Lead | Cloud |
| [[Lena Fischer]] | Product Manager | Product |
| [[Raj Patel]] | Sales Director | Sales |
| [[Chloe Martin]] | Marketing Lead | Marketing |
| [[Ines Duarte]] | Support Lead | Support |
| [[Mateo Garcia]] | Finance Lead | Finance |
| [[Elif Demir]] | Compliance Manager | Operations |
| [[Nora Berg]] | People and HR | People |

Hardware team: [[Alex Kim]], [[Hana Sato]], [[Oskar Lind]]. Firmware: [[Ben Carter]]. Cloud: [[Yuki Tanaka]], [[David Osei]]. Ops: [[Sofia Russo]].
`);

// ---------- customers ----------
n('Customers/Northwind Schools.md', `
---
tags: [customer, education]
aliases: [Northwind, NWS, Northwind School District]
owner: "[[Raj Patel]]"
status: negotiating
---
# Northwind Schools

Private school trust, 14 schools in the north of England. Pilot of 12 units ran in 2026-05.

## Contacts
- [[Alex Kim (Northwind)]] — procurement
- Head of estates: Gemma Hart

## Deal
120 units, quote [[Northwind Quote Q-2026-114]]. Decision expected 2026-12.

## Pricing reference
![[Price List#Current prices]]
`);

n('Customers/Contacts/Alex Kim (Northwind).md', `
---
tags: [contact, customer]
aliases: [Alex Kim]
company: "[[Northwind Schools]]"
---
# Alex Kim (Northwind)

Procurement manager at Northwind Schools. Prefers email, needs quotes as PDF. Not our QA engineer.
`);

n('Customers/Helio Clinics.md', `
---
tags: [customer, healthcare]
aliases: [Helio]
owner: "[[Raj Patel]]"
status: won
---
# Helio Clinics

Chain of 9 physiotherapy clinics. Contact: Jonas Berg (operations).

## Order
40 units, [[Helio Quote Q-2026-121]]. We promised first shipment the week after launch (mid-March 2027).
`);

const customer = (name, o) => n(`Customers/${name}.md`, `
---
tags: [customer, ${o.seg}]
owner: "[[${o.owner}]]"
status: ${o.status}
---
# ${name}

${o.desc}

## Notes
${o.notes}
`);
customer('Ostra Offices', { seg: 'office', owner: 'Raj Patel', status: 'prospect', desc: 'Serviced office operator, 6 buildings in Oslo.', notes: 'Wants CO2 alerts in meeting rooms; interested in Cloud Plus exports for their ESG report.' });
customer('Lumen Coworking', { seg: 'office', owner: 'Raj Patel', status: 'pilot', desc: 'Coworking chain in Lisbon and Porto. Not related to [[Project Lumen]].', notes: 'Pilot of 10 Brisa units since 2026-10; feedback: status ring colours too subtle.' });
customer('Bergen Libraries', { seg: 'education', owner: 'Raj Patel', status: 'prospect', desc: 'Municipal library network.', notes: 'Tender opens 2027-02; requires 24-month warranty (we now meet it).' });
customer('Calder Hotels', { seg: 'hospitality', owner: 'Raj Patel', status: 'lost', desc: 'Boutique hotel group.', notes: 'Chose a wired building system; revisit in 2028.' });
customer('Pinewood Gyms', { seg: 'fitness', owner: 'Raj Patel', status: 'prospect', desc: 'Gym chain, 22 sites.', notes: 'High CO2 in spin rooms; would need the wall mount kit.' });
customer('Riverside Dental', { seg: 'healthcare', owner: 'Raj Patel', status: 'prospect', desc: 'Dental group, 5 practices.', notes: 'Asked about aerosol monitoring; PM sensor relevant.' });

// ---------- meetings ----------
const meeting = (date, title, attendees, body) => n(`Meetings/${date} ${title}.md`, `
---
tags: [meeting]
date: ${date}
attendees: [${attendees.join(', ')}]
---
# ${title} (${date})

${body}
`);
meeting('2026-06-02', 'Sensor Selection', ['Marta Okafor', 'Oskar Lind', 'Alex Kim'], `## Notes
- Pintail drift data reviewed: 30 % after 3 months.
- Kestrel samples passed the smoke-box test.
- Outcome: [[2026-06-02 Choose Kestrel PM40]].`);
meeting('2026-07-08', 'Firmware Standup', ['Priya Raman', 'Ben Carter'], `## Notes
- Priya R. presented the BLE mesh power numbers; decision in [[2026-07-08 Drop BLE mesh]].
- Ben: display driver prototype in [[Project Lumen]].`);
meeting('2026-08-12', 'Board Update', ['Jonas Weber', 'Mateo Garcia'], `## Finance
Mateo: the company has 18 months of runway at current burn. Seed extension closes in Q1.

## Product
JW confirmed two products at launch.`);
meeting('2026-09-30', 'Leadership Sync', ['JW', 'Lena Fischer', 'Marta O.', 'Raj Patel'], `## Launch
DVT slipped a week. Launch stays on 3/15. See [[2026-09-30 Keep launch date]].

## Hiring
Two firmware roles opened.`);
meeting('2026-10-02', 'Pricing Review', ['Jonas Weber', 'Raj Patel', 'Mateo Garcia'], `## Discussion
Sensor costs are up €3 per unit. Tenders already submitted use list price.

## Outcome
We agreed to hold the price at two hundred and forty-nine euros through launch ([[2026-10-02 Hold price through launch]]).`);
meeting('2026-10-09', 'Sales Pipeline', ['Raj Patel', 'Chloe Martin'], `## Pipeline
- NWS: quote going out this month, 120 units.
- Helio: verbal yes, 40 units.
- New lead: Northwind Traders, a Danish office-supply distributor, wants reseller terms.`);
meeting('2026-10-15', 'Supplier Call Kestrel', ['Oskar Lind', 'Marta O.', 'Wei Lin (Kestrel)'], `## Notes
Kestrel confirmed lead time is now 16 weeks because of wafer allocation; MOQ unchanged at 5k. Price holds at €11.80.

## Actions
- Oskar: move the first PO forward to 2026-11-01.`);
meeting('2026-10-20', 'Hardware Review', ['MO', 'Hana Sato', 'Alex Kim', 'Oskar Lind'], `## Enclosure
Marta O. reviewed the thermal results: ghosting above 45 °C. Options: change the spec to 45 °C or add a heat shield.

## Power
Battery test rig shows 17.9 months projected; OK against target.`);
meeting('2026-11-03', 'Launch Readiness', ['Chloe Martin', 'Ines Duarte', 'Sofia Russo'], `## Status
- Press release draft ready for review.
- Support FAQ needs the new warranty wording check.
- Atlas confirmed Rotterdam capacity for March.`);
const generic = [
  ['2026-06-16', 'Weekly Sync', ['Lena Fischer', 'Marta Okafor', 'Tomasz Nowak'], '- EVT1 boards back from CirQ.\n- Atlas backend skeleton deployed to staging.'],
  ['2026-06-23', 'Weekly Sync', ['Lena Fischer', 'Priya Raman'], '- Firmware sampling loop working.\n- Open question: default interval (agreed 10 min, see Glossary).'],
  ['2026-06-30', 'Weekly Sync', ['Lena Fischer', 'JW'], '- Brisa Mini scope confirmed: no PM sensor.'],
  ['2026-07-14', 'Weekly Sync', ['Lena Fischer', 'Tomasz Nowak'], '- Atlas API auth design done (OAuth client credentials).'],
  ['2026-07-21', 'Design Review', ['Hana Sato', 'MO'], '- Enclosure airflow v2 approved.\n- Colour Cloud White chosen.'],
  ['2026-07-28', 'Weekly Sync', ['Lena Fischer', 'Ines Duarte'], '- Support tooling: helpdesk selected.'],
  ['2026-08-04', 'Weekly Sync', ['Lena Fischer', 'Yuki Tanaka'], '- Purge job load-tested.'],
  ['2026-08-18', 'Marketing Sync', ['Chloe Martin', 'Raj Patel'], '- "Brisa One" chosen as consumer name.\n- Website agency briefed.'],
  ['2026-08-25', 'Weekly Sync', ['Lena Fischer', 'Priya R.'], '- OTA staged rollout design reviewed.'],
  ['2026-09-08', 'Weekly Sync', ['Lena Fischer', 'Oskar Lind'], '- Moldwright tool kick-off.\n- Voltera cells: UN38.3 paperwork received.'],
  ['2026-09-15', 'Support Sync', ['Ines Duarte', 'Raj Patel'], '- New warranty term agreed yesterday; FAQ update pending.'],
  ['2026-09-22', 'Weekly Sync', ['Lena Fischer', 'Alex Kim'], '- Nightly rig at 12 units.'],
  ['2026-10-06', 'Weekly Sync', ['Lena Fischer', 'David Osei'], '- App onboarding flow in usability testing.'],
  ['2026-10-13', 'Cloud Sync', ['Tomasz Nowak', 'Yuki Tanaka'], '- The Atlas API rate limit set at 600/min.\n- Frankfurt region only for launch.'],
  ['2026-10-27', 'Weekly Sync', ['Lena Fischer', 'Elif Demir'], '- TÜV pre-scan booked for December.'],
  ['2026-11-02', 'Ops Sync', ['Sofia Russo', 'Marta Oliveira (Atlas Logistics)'], '- Marta O. from Atlas Logistics confirmed return pickup pricing.\n- Spare cells stock: 300.'],
];
generic.forEach(([d, t, a, b]) => meeting(d, t, a, `## Notes\n${b}`));

// ---------- journal ----------
const days = {
  '2026-11-02': 'Reviewed the Kestrel PO timing with Oskar. Need to confirm the 16-week lead time in writing.',
  '2026-11-03': 'Launch readiness meeting. Press release still says March 15.',
  '2026-11-04': 'Looked at Northwind quote; Alex wants a PDF.',
  '2026-11-05': 'Thermal: still undecided between 45 °C spec and heat shield.',
  '2026-11-06': 'Quiet day. Cleaned up the vault templates.',
};
Object.entries(days).forEach(([d, t]) => n(`Journal/${d}.md`, `# ${d}\n\n${t}\n`));

// ---------- private ----------
n('Private/HR/Salary Bands.md', `
---
tags: [hr, confidential]
owner: "[[Nora Berg]]"
---
# Salary Bands

| Level | Band (EUR gross/year) |
|---|---|
| Engineer | €58,000–€74,000 |
| Senior Engineer | €78,000–€96,000 |
| Lead | €98,000–€118,000 |
`);
n('Private/HR/Org Changes.md', `
---
tags: [hr, confidential]
owner: "[[Nora Berg]]"
updated: 2026-10-30
---
# Org Changes

## Engineering leadership
Effective 2027-01-01, Priya Raman becomes VP Engineering; Tomasz Nowak will report to her. Not announced yet.
`);
n('Private/HR/Hiring Plan 2027.md', `
---
tags: [hr, confidential]
---
# Hiring Plan 2027

- 4 firmware engineers (two reporting to the Head of Hardware for board bring-up)
- 1 support agent before launch
- Budget approved by [[Jonas Weber]]
`);
n('Private/HR/Performance Review - Marta Okafor.md', `
---
tags: [hr, confidential, review]
---
# Performance Review - Marta Okafor

Rating: exceeds. Delivered EVT2 on time; recommended for promotion to VP Hardware in 2027.
`);
n('Private/HR/Leave Calendar.md', `
# Leave Calendar

- Oskar Lind: 2026-12-21 to 2027-01-04
- Raj Patel: 2027-02-10 to 2027-02-17
`);

// ---------- excluded / distractor folders ----------
n('Templates/Meeting Template.md', `
---
tags: [meeting]
date: {{date}}
attendees: []
---
# {{title}} ({{date}})

## Notes
- Brisa costs €249 (placeholder example, do not index)
`);
n('Templates/Decision Template.md', `
---
tags: [decision]
status: proposed
---
# {{title}}

## Context
## Decision
## Consequences
`);
n('.trash/Pricing 2025 (old).md', `
# Pricing 2025 (old)

Brisa €229, Brisa Mini €99. Volume discount 15% over 50 units.
`);
n('.obsidian/app.json', JSON.stringify({ attachmentFolderPath: 'Attachments', userIgnoreFilters: ['Templates/'], newLinkFormat: 'shortest', useMarkdownLinks: false }, null, 2) + '\n');
n('.obsidian/core-plugins.json', JSON.stringify(['file-explorer', 'global-search', 'backlink', 'graph', 'templates', 'daily-notes'], null, 2) + '\n');
n('.obsidian/daily-notes.json', JSON.stringify({ folder: 'Journal', template: 'Templates/Meeting Template' }, null, 2) + '\n');
n('Attachments/bom-export.csv', `part_number,description,supplier,qty_per_unit,unit_cost_eur
KS-PM40,Particulate sensor,Kestrel Sensors,1,11.80
NDIR-C8,CO2 sensor,—,1,14.20
VC-18,18650 Li-ion cell 3400 mAh,Voltera Cells,1,2.49
IL-29,2.9in e-ink panel,Inkline Displays,1,6.10
BR-100-MB,Main PCB rev C,Circuitry Partners,1,9.40
BR-100-ENC,Enclosure set,Moldwright Plastics,1,3.15
`);

// ---------- boilerplate padding (template-like sections, identical apart from the title) ----------
const FILL = {
  Meetings: (t) => `## Actions\n- Owners update the tracker before the next sync.\n- The facilitator files these notes under Meetings and tags open items.\n\n## Parking lot\nAnything not covered in "${t}" moves to the next weekly agenda if it is still relevant.`,
  People: (t) => `## Working style\n${t} prefers async updates in the team channel and keeps focus-time blocks in the shared calendar. Out-of-office periods are visible there too.`,
  Parts: (t) => `## Quality\nIncoming inspection samples each lot of ${t} against the drawing. No open engineering change orders; deviations need a signed concession.`,
  Suppliers: (t) => `## Supplier management\n${t} is reviewed in the quarterly business review. Operations keeps the scorecard (quality, delivery, responsiveness). No open corrective actions.`,
  Customers: (t) => `## Account history\n${t} came in through an inbound demo request. The owner keeps the CRM record current and logs every call there, not in this note.`,
  Journal: () => `## Tasks\n- Clear inbox and review pull requests\n- Update the weekly notes\n\n## Thoughts\nNothing else notable; keep an eye on open review comments and unanswered threads.`,
  _: (t) => `## Review\nThis page ("${t}") is reviewed whenever the owning team changes the underlying process. Questions go to the page owner or the team channel.`,
};
for (const p of Object.keys(N)) {
  if (!p.endsWith('.md') || /^(Templates|\.trash)\//.test(p)) continue;
  const words = () => N[p].split(/\s+/).length;
  if (words() >= 50) continue;
  const title = p.split('/').pop().replace(/\.md$/, '');
  const fill = FILL[p.split('/')[0]] || FILL._;
  N[p] = N[p].replace(/\n*$/, '\n\n') + fill(title) + '\n';
  if (words() < 50) N[p] += '\n' + FILL._(title) + '\n';
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from(`%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 52>>stream
BT /F1 12 Tf 20 50 Td (Brisa datasheet placeholder) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`);
module.exports = { notes: N, binaries: { 'Attachments/brisa-board.png': PNG, 'Attachments/Brisa Datasheet.pdf': PDF } };
