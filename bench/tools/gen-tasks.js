// Task definitions. Paths are relative to the generated vault. section: heading text | "frontmatter" | "" (whole note).
const R = (path, old, nw) => ({ op: 'replace', path, old, new: nw });
const C = (path, content) => ({ op: 'create', path, content });
const s = (path, section, evidence, x = {}) => ({ path, section, evidence, ...x });
// impact item: reasons[], verdict stale|contradicts|ok, detect K1|K3
const a = (path, section, reasons, verdict, detect, evidence, why) => ({ path, section, reasons, verdict, detect, evidence, ...(why ? { why } : {}) });

const T = { impact: [], staleness: [], contradiction: [], entity_merge: [], context_qa: [], summary: [] };
const add = (cat, t) => T[cat].push({ category: cat, ...t });

// ================= IMPACT =================
add('impact', { id: 'impact-01', difficulty: 'easy', description: 'Brisa list price changes in the hub price list.',
  setup: [R('Sales/Price List.md', '| [[Brisa]] | BR-100 | €249 |', '| [[Brisa]] | BR-100 | €279 |')],
  changed: s('Sales/Price List.md', 'Current prices', '€279'),
  ground_truth: {
    affected: [
      a('Support/Support FAQ.md', 'Buying', ['depends_on', 'wikilink', 'restated_fact'], 'stale', 'K1', 'The Brisa costs €249 before VAT'),
      a('Sales/Pitch Notes.md', 'Price talk', ['restated_fact'], 'stale', 'K3', 'A Brisa retails for 249 euros', 'no link, number in words+digits'),
      a('Marketing/Website Copy.md', 'Hero', ['restated_fact'], 'stale', 'K3', 'Clean air for €249.'),
      a('Sales/Quotes/Northwind Quote Q-2026-114.md', 'Northwind Quote Q-2026-114', ['restated_fact'], 'stale', 'K3', '| Brisa (BR-100) | 120 | €249 | €29,880 |', 'draft quote; totals derived from price must be recomputed'),
      a('Sales/Quotes/Helio Quote Q-2026-121.md', 'Helio Quote Q-2026-121', ['restated_fact'], 'stale', 'K3', '| Brisa (BR-100) | 40 | €249 | €9,960 |'),
      a('Decisions/2026-10-02 Hold price through launch.md', 'Decision', ['restated_fact'], 'contradicts', 'K3', 'Brisa stays at €249', 'edit violates an accepted decision; needs a new decision, not a silent fix'),
    ],
    ok_candidates: [
      a('Customers/Northwind Schools.md', 'Pricing reference', ['embed'], 'ok', 'K1', '![[Price List#Current prices]]', 'embed renders live'),
      a('Meetings/2026-10-02 Pricing Review.md', 'Outcome', ['paraphrase'], 'ok', 'K3', 'two hundred and forty-nine euros', 'dated historical record'),
      a('Plans/Launch Plan.md', 'frontmatter', ['depends_on'], 'ok', 'K1', '"[[Price List]]"'),
      a('Sales/Sales Playbook.md', 'Segments', ['wikilink'], 'ok', 'K1', '[[price list]]', 'case variant link'),
    ],
    must_not_flag: [
      s('Policies/Travel Policy.md', 'Hotels', 'Hotel cap €249 per night', { why: 'same number, unrelated' }),
      s('Parts/Voltera VC-18 Cell.md', 'Specs', '€2.49', { why: 'look-alike number' }),
      s('Products/Brisa Mini.md', 'Price', 'List price €119', { why: 'different product' }),
      s('.trash/Pricing 2025 (old).md', '', 'Brisa €229', { why: 'excluded folder' }),
      s('Templates/Meeting Template.md', '', 'Brisa costs €249 (placeholder', { why: 'excluded folder' }),
      s('Archive/Brisa v0 Spec.md', '', 'Target price €199', { why: 'archived' }),
    ] } });

add('impact', { id: 'impact-02', difficulty: 'medium', description: 'Battery life in the hardware spec drops from 18 to 14 months (head of a 5-deep depends_on chain).',
  setup: [R('Specs/Brisa Hardware Spec.md', 'Battery life: 18 months at', 'Battery life: 14 months at')],
  changed: s('Specs/Brisa Hardware Spec.md', 'Power', 'Battery life: 14 months'),
  ground_truth: {
    affected: [
      a('Design/Power Design.md', 'Budget', ['depends_on', 'wikilink', 'restated_fact'], 'stale', 'K1', 'targets the 18 months of battery life'),
      a('Runbooks/Battery Replacement.md', 'When', ['chain', 'paraphrase'], 'stale', 'K3', 'roughly every year and a half', 'chain: spec→Power Design→Battery Replacement (depends_on)'),
      a('Support/Support FAQ.md', 'Battery', ['chain', 'restated_fact'], 'stale', 'K3', 'About 18 months on default settings', 'chain depth 4 via Battery Replacement'),
      a('Marketing/Launch Messaging.md', 'Proof points', ['restated_fact'], 'stale', 'K3', 'Up to 18 months on a single charge'),
      a('Sales/Pitch Notes.md', 'Objections', ['paraphrase'], 'stale', 'K3', 'about a year and a half on default settings'),
    ],
    ok_candidates: [
      a('Plans/Manufacturing Plan.md', 'frontmatter', ['chain', 'depends_on'], 'ok', 'K1', '"[[Power Design]]"', 'chain depth 2, no battery-life claim'),
      a('Plans/Test Plan.md', 'Battery tests', ['wikilink'], 'ok', 'K1', '[[Brisa Hardware Spec#Power]]', 'refers to the target generically'),
      a('Specs/Brisa Firmware Spec.md', 'frontmatter', ['depends_on'], 'ok', 'K1', '"[[Brisa Hardware Spec]]"'),
      a('Design/Enclosure Design.md', 'frontmatter', ['depends_on'], 'ok', 'K1', '"[[Brisa Hardware Spec]]"'),
      a('Meetings/2026-10-20 Hardware Review.md', 'Power', ['restated_fact'], 'ok', 'K3', '17.9 months projected', 'historical record'),
      a('Decisions/2026-05-20 E-ink over LCD.md', 'Context', ['restated_fact'], 'ok', 'K3', '18-month battery target', 'historical record'),
    ],
    must_not_flag: [
      s('Meetings/2026-08-12 Board Update.md', 'Finance', '18 months of runway', { why: 'same number, finance' }),
      s('Products/Brisa Mini.md', 'Power', 'about 12 months of battery life', { why: 'different product' }),
      s('Archive/Brisa v0 Spec.md', '', '9 months life', { why: 'archived prototype' }),
    ] } });

add('impact', { id: 'impact-03', difficulty: 'medium', description: 'Public launch moves from 2027-03-15 to 2027-04-12 in the roadmap.',
  setup: [R('Plans/Roadmap 2027.md', '| Public launch | 2027-03-15 |', '| Public launch | 2027-04-12 |')],
  changed: s('Plans/Roadmap 2027.md', 'Milestones', '2027-04-12'),
  ground_truth: {
    affected: [
      a('Plans/Launch Plan.md', 'Date', ['depends_on', 'restated_fact'], 'stale', 'K1', 'Launch day is 15 March 2027.'),
      a('Marketing/Press Release Draft.md', 'Press Release Draft', ['restated_fact'], 'stale', 'K3', 'available from March 15, 2027'),
      a('Customers/Helio Clinics.md', 'Order', ['paraphrase'], 'stale', 'K3', 'mid-March 2027'),
      a('Decisions/2026-09-30 Keep launch date.md', 'Decision', ['restated_fact'], 'contradicts', 'K3', 'The public launch stays on 2027-03-15.'),
    ],
    ok_candidates: [
      a('Meetings/2026-09-30 Leadership Sync.md', 'Launch', ['restated_fact'], 'ok', 'K3', 'Launch stays on 3/15.', 'historical; US date format'),
      a('Journal/2026-11-03.md', '', ['restated_fact'], 'ok', 'K3', 'Press release still says March 15.', 'journal entry, historical'),
    ],
    must_not_flag: [
      s('Archive/Old Roadmap 2026.md', '', 'Planned launch Q4 2026', { why: 'superseded archive' }),
      s('Plans/Certification Plan.md', 'Timeline', 'CE submission due 2027-01-15', { why: 'different milestone, similar date' }),
    ] } });

add('impact', { id: 'impact-04', difficulty: 'easy', description: 'Heading rename breaks anchor links: "## Power" becomes "## Power budget".',
  setup: [R('Specs/Brisa Hardware Spec.md', '## Power\n- Battery:', '## Power budget\n- Battery:')],
  changed: s('Specs/Brisa Hardware Spec.md', 'Power budget', 'Battery life'),
  ground_truth: {
    affected: [
      a('Design/Power Design.md', 'Budget', ['wikilink'], 'stale', 'K1', '[[Brisa Hardware Spec#Power]]', 'broken heading anchor'),
      a('Plans/Test Plan.md', 'Battery tests', ['wikilink'], 'stale', 'K1', '[[Brisa Hardware Spec#Power]]', 'broken heading anchor'),
    ],
    ok_candidates: [],
    must_not_flag: [
      s('Home.md', 'Product', '[[Brisa Hardware Spec]]', { why: 'link without anchor still resolves' }),
      s('Engineering/Engineering Onboarding.md', '', '[[Brisa Hardware Spec]]', { why: 'link without anchor' }),
      s('Products/Brisa.md', 'Documents', '[[Brisa Hardware Spec]]', { why: 'link without anchor' }),
    ] } });

add('impact', { id: 'impact-05', difficulty: 'medium', description: 'Kestrel MOQ rises from 5,000 to 10,000 units.',
  setup: [R('Suppliers/Kestrel Sensors.md', '- MOQ: 5,000 units per order', '- MOQ: 10,000 units per order')],
  changed: s('Suppliers/Kestrel Sensors.md', 'Commercial terms', '10,000 units'),
  ground_truth: {
    affected: [
      a('Plans/Manufacturing Plan.md', 'Sensor supply', ['depends_on', 'restated_fact'], 'stale', 'K1', '5,000-unit minimum order'),
      a('Parts/KS-PM40 Sensor.md', 'Key data', ['fm_supplier', 'restated_fact'], 'stale', 'K3', 'Buying: MOQ 5k', 'frontmatter supplier link is a K1 signal; the 5k restatement needs K3'),
    ],
    ok_candidates: [
      a('Meetings/2026-10-15 Supplier Call Kestrel.md', 'Notes', ['restated_fact'], 'ok', 'K3', 'MOQ unchanged at 5k', 'historical'),
      a('Decisions/2026-06-02 Choose Kestrel PM40.md', 'Consequences', ['wikilink'], 'ok', 'K1', '[[Kestrel Sensors]]'),
    ],
    must_not_flag: [
      s('Plans/Manufacturing Plan.md', 'Volumes', 'first production run 5,000 units', { why: 'same number, production volume (section-level precision)' }),
      s('Suppliers/Voltera Cells.md', 'Terms', 'MOQ 10,000 cells', { why: 'other supplier' }),
      s('Glossary.md', 'MOQ', 'Minimum order quantity', { why: 'definition only' }),
    ] } });

add('impact', { id: 'impact-06', difficulty: 'hard', description: 'Raw data retention changes 90 → 180 days (policy sits in a depends_on cycle).',
  setup: [R('Policies/Data Retention Policy.md', '| Raw sensor readings | 90 days |', '| Raw sensor readings | 180 days |')],
  changed: s('Policies/Data Retention Policy.md', 'Retention periods', '180 days'),
  ground_truth: {
    affected: [
      a('Specs/Cloud API Spec.md', 'Readings endpoint', ['depends_on', 'restated_fact'], 'stale', 'K1', 'older than 90 days return'),
      a('Support/Support FAQ.md', 'Data', ['wikilink', 'restated_fact'], 'stale', 'K1', 'Raw readings for 90 days'),
      a('Policies/Privacy Policy.md', 'How long', ['paraphrase'], 'stale', 'K3', 'raw readings for three months'),
      a('Design/Cloud Architecture.md', 'Storage', ['chain', 'restated_fact'], 'contradicts', 'K3', 'purged after 30 days', 'cycle member; already disagreed before the edit'),
      a('Decisions/2026-08-05 Raw data retention 90 days.md', 'Decision', ['wikilink', 'restated_fact'], 'contradicts', 'K3', 'retained for 90 days'),
    ],
    ok_candidates: [],
    must_not_flag: [
      s('Sales/Sales Playbook.md', 'Terms', '90-day payment terms', { why: 'same number, payment terms' }),
      s('Policies/Returns Policy.md', 'Change of mind', 'within 30 days', { why: 'returns window' }),
      s('Policies/Expense Policy.md', 'Claims', 'within 30 days', { why: 'expense deadline' }),
    ] } });

add('impact', { id: 'impact-07', difficulty: 'medium', description: 'Warranty extended from 2 to 3 years in the policy.',
  setup: [R('Policies/Warranty Policy.md', 'carry a 2-year warranty', 'carry a 3-year warranty')],
  changed: s('Policies/Warranty Policy.md', 'Term', '3-year warranty'),
  ground_truth: {
    affected: [
      a('Support/Support FAQ.md', 'Warranty', ['depends_on', 'wikilink', 'paraphrase'], 'stale', 'K1', 'covered for two years from delivery'),
      a('Sales/Sales Playbook.md', 'Offer', ['restated_fact'], 'stale', 'K3', 'two-year warranty'),
      a('Marketing/Website Copy.md', 'Footer', ['restated_fact'], 'stale', 'K3', 'Two-year warranty.'),
      a('Support/Warranty FAQ.md', 'Coverage', ['restated_fact'], 'stale', 'K3', '12-month limited warranty', 'was already outdated'),
      a('Runbooks/RMA Process.md', 'Eligibility', ['restated_fact'], 'stale', 'K3', '1-year warranty window', 'was already outdated'),
      a('Decisions/2026-09-14 Extend warranty to 2 years.md', 'Decision', ['wikilink', 'restated_fact'], 'contradicts', 'K1', 'get a 2-year warranty'),
    ],
    ok_candidates: [
      a('Customers/Bergen Libraries.md', 'Notes', ['paraphrase'], 'ok', 'K3', 'requires 24-month warranty', 'still satisfied'),
      a('Glossary.md', 'Warranty', ['wikilink'], 'ok', 'K1', '[[Warranty Policy]]'),
      a('Policies/Returns Policy.md', 'Faulty units', ['wikilink'], 'ok', 'K1', '[[Warranty Policy]]'),
    ],
    must_not_flag: [
      s('Policies/Data Retention Policy.md', 'Retention periods', '| Hourly aggregates | 2 years |', { why: 'same number, data retention' }),
      s('Support/Support FAQ.md', 'Data', 'hourly averages for two years', { why: 'same phrase, other section' }),
    ] } });

add('impact', { id: 'impact-08', difficulty: 'easy', description: 'Glossary (fan-out hub) changes the default sampling interval 10 → 5 minutes.',
  setup: [R('Glossary.md', 'Default 10 minutes; configurable', 'Default 5 minutes; configurable')],
  changed: s('Glossary.md', 'Sampling interval', 'Default 5 minutes'),
  ground_truth: {
    affected: [
      a('Specs/Brisa Firmware Spec.md', 'Sampling', ['wikilink', 'restated_fact'], 'stale', 'K1', 'default interval of 10 minutes', 'anchor link [[Glossary#Sampling interval|…]]'),
      a('Specs/Brisa Hardware Spec.md', 'Power', ['restated_fact'], 'stale', 'K3', 'default 10-minute sampling interval'),
      a('Design/Mobile App Design.md', 'Settings', ['restated_fact'], 'stale', 'K3', 'defaults to 10 min'),
    ],
    ok_candidates: [
      a('Meetings/2026-06-23 Weekly Sync.md', 'Notes', ['restated_fact'], 'ok', 'K3', 'agreed 10 min, see Glossary', 'historical'),
    ],
    ambiguous: [s('Specs/Sensor Requirements.md', 'Particulate', 'at a 10-minute duty cycle', { why: 'test condition, may or may not follow the default' })],
    must_not_flag: [
      s('Home.md', 'Company', '[[Glossary]]', { why: 'hub link without anchor' }),
      s('Sales/Sales Playbook.md', 'Glossary', '[[Glossary]]', { why: 'hub link without anchor' }),
      s('Engineering/Engineering Onboarding.md', '', '[[Glossary]]', { why: 'hub link without anchor' }),
    ] } });

add('impact', { id: 'impact-09', difficulty: 'hard', description: 'OTA rollout stages change to 1% → 10% → 100% (source of a near-duplicate paragraph and an embed).',
  setup: [R('Design/OTA Design.md', '5% of the fleet, then 25%, then 100%', '1% of the fleet, then 10%, then 100%')],
  changed: s('Design/OTA Design.md', 'Rollout stages', '1% of the fleet'),
  ground_truth: {
    affected: [
      a('Runbooks/OTA Rollout.md', 'Stages', ['near_dup'], 'stale', 'K1', '5% of the fleet, then 25%, then 100%', 'near-duplicate paragraph, no link'),
      a('Runbooks/Incident Response.md', 'Bad firmware', ['wikilink', 'restated_fact'], 'stale', 'K1', 'stage 1 (5% of devices)'),
    ],
    ok_candidates: [
      a('Specs/Brisa Firmware Spec.md', 'OTA', ['embed'], 'ok', 'K1', '![[OTA Design#Rollout stages]]', 'embed renders live'),
      a('Meetings/2026-08-25 Weekly Sync.md', 'Notes', ['paraphrase'], 'ok', 'K3', 'OTA staged rollout design reviewed', 'historical, no numbers'),
    ],
    must_not_flag: [
      s('Glossary.md', 'Soak period', '24 hours between OTA stages', { why: 'soak unchanged' }),
      s('Sales/Price List.md', 'Discounts', '10% off orders over 100 units', { why: 'look-alike percentages' }),
    ] } });

add('impact', { id: 'impact-10', difficulty: 'medium', description: 'Factory-reset gesture changes in the agent troubleshooting page.',
  setup: [R('Support/Troubleshooting.md', 'for 10 seconds until the screen flashes twice', 'for 15 seconds until the screen flashes three times')],
  changed: s('Support/Troubleshooting.md', 'Factory reset', '15 seconds'),
  ground_truth: {
    affected: [
      a('Support/Support FAQ.md', 'Reset', ['near_dup', 'wikilink'], 'stale', 'K1', 'Hold the button on the back for 10 seconds', 'near-duplicate; Troubleshooting links [[support faq]] (case variant)'),
      a('Support/Support Macros.md', 'Reset macro', ['paraphrase'], 'stale', 'K3', '10-second reset'),
    ],
    ok_candidates: [],
    must_not_flag: [
      s('Design/Power Design.md', 'Sleep strategy', '8-second measurement window', { why: 'unrelated duration' }),
      s('Specs/Brisa Firmware Spec.md', 'Sampling', 'for 8 seconds', { why: 'unrelated duration' }),
    ] } });

add('impact', { id: 'impact-11', difficulty: 'hard', description: 'Edit inside a block (^choice) referenced by block links, one malformed: Pintail kept as second source.',
  setup: [R('Decisions/2026-06-02 Choose Kestrel PM40.md', 'replacing the Pintail PM25 used in the v0 prototypes. ^choice', 'keeping the Pintail PM25 as an approved second source. ^choice')],
  changed: s('Decisions/2026-06-02 Choose Kestrel PM40.md', 'Decision', 'approved second source'),
  ground_truth: {
    affected: [
      a('Archive/Pintail PM25 Sensor.md', 'Pintail PM25 Sensor', ['wikilink', 'restated_fact'], 'stale', 'K3', 'Retired particulate sensor', 'status: retired now wrong'),
      a('Glossary.md', 'PM2.5', ['restated_fact'], 'stale', 'K3', 'the retired Pintail PM25 sensor'),
    ],
    ok_candidates: [
      a('Plans/Manufacturing Plan.md', 'Sensor supply', ['wikilink'], 'ok', 'K1', '[[2026-06-02 Choose Kestrel PM40#^choice]]', 'block link'),
      a('Parts/KS-PM40 Sensor.md', 'KS-PM40 Sensor', ['wikilink'], 'ok', 'K1', '[[2026-06-02 Choose Kestrel PM40^choice]]', 'malformed block link; lenient parser should resolve it'),
      a('Meetings/2026-06-02 Sensor Selection.md', 'Notes', ['wikilink'], 'ok', 'K1', '[[2026-06-02 Choose Kestrel PM40]]'),
    ],
    must_not_flag: [
      s('Archive/Brisa v0 Spec.md', '', 'Particulate sensor: Pintail PM25', { why: 'describes the prototypes, still true' }),
      s('Runbooks/Sensor Calibration.md', 'PM check', 'golden unit', { why: 'unrelated' }),
    ] } });

add('impact', { id: 'impact-12', difficulty: 'hard', description: 'Marta Okafor is promoted: role "Head of Hardware" → "VP Hardware". Look-alike: Marta Oliveira (Atlas Logistics).',
  setup: [R('People/Marta Okafor.md', '**Role:** Head of Hardware.', '**Role:** VP Hardware.')],
  changed: s('People/Marta Okafor.md', 'Marta Okafor', 'VP Hardware'),
  ground_truth: {
    affected: [
      a('People/Org Chart.md', 'Org Chart', ['wikilink', 'restated_fact'], 'stale', 'K1', '| [[Marta Okafor\\|Marta]] | Head of Hardware | Hardware |', 'link with escaped pipe alias inside a table'),
      a('Plans/Certification Plan.md', 'Sign-off', ['restated_fact'], 'stale', 'K3', 'Head of Hardware signs the declaration of conformity.', 'role title, no name'),
      a('Private/HR/Hiring Plan 2027.md', 'Hiring Plan 2027', ['restated_fact'], 'stale', 'K3', 'reporting to the Head of Hardware', 'private: only visible to a curator with Private/ read'),
    ],
    ok_candidates: [
      a('Design/Enclosure Design.md', 'Enclosure Design', ['restated_fact'], 'ok', 'K3', 'Reviewed by the Head of Hardware on 2026-10-20', 'past event, title correct at the time'),
      a('People/Hana Sato.md', 'frontmatter', ['fm_manager'], 'ok', 'K1', '"[[Marta Okafor]]"'),
    ],
    must_not_flag: [
      s('Suppliers/Atlas Logistics.md', 'Contacts', 'Marta Oliveira', { why: 'different person' }),
      s('Meetings/2026-11-02 Ops Sync.md', 'Notes', 'Marta O. from Atlas Logistics', { why: 'alias collision, different person' }),
    ] } });

add('impact', { id: 'impact-13', difficulty: 'medium', description: 'Cell capacity corrected 3,400 → 3,000 mAh in the part note.',
  setup: [R('Parts/Voltera VC-18 Cell.md', 'Capacity: 3,400 mAh nominal', 'Capacity: 3,000 mAh nominal')],
  changed: s('Parts/Voltera VC-18 Cell.md', 'Specs', '3,000 mAh'),
  ground_truth: {
    affected: [
      a('Specs/Brisa Hardware Spec.md', 'Power', ['depends_on', 'wikilink', 'restated_fact'], 'stale', 'K1', '(3,400 mAh)'),
      a('Design/Power Design.md', 'Budget', ['depends_on', 'restated_fact'], 'stale', 'K1', '3,400 mAh 18650 cell', 'derived 18.6-month figure also wrong'),
    ],
    ok_candidates: [
      a('Runbooks/Battery Replacement.md', 'Steps', ['wikilink'], 'ok', 'K1', '[[Voltera VC-18 Cell|VC18]]'),
      a('Plans/Manufacturing Plan.md', 'Cells', ['wikilink'], 'ok', 'K1', '[[Voltera VC-18 Cell|Voltera cells]]'),
    ],
    ambiguous: [s('Attachments/bom-export.csv', '', '18650 Li-ion cell 3400 mAh', { why: 'non-markdown attachment; stale if CSVs are indexed' })],
    must_not_flag: [
      s('Suppliers/Voltera Cells.md', 'Voltera Cells', '5,000 mAh', { why: 'VC-21, not used' }),
      s('Products/Brisa Mini.md', 'Power', '2 × AA lithium cells', { why: 'different product' }),
    ] } });

add('impact', { id: 'impact-14', difficulty: 'easy', description: 'Negative case: hotel cap €249 → €270. The number collides with the Brisa price; nothing is stale.',
  setup: [R('Policies/Travel Policy.md', 'Hotel cap €249 per night', 'Hotel cap €270 per night')],
  changed: s('Policies/Travel Policy.md', 'Hotels', '€270'),
  ground_truth: {
    affected: [],
    ok_candidates: [a('Policies/Expense Policy.md', 'Claims', ['wikilink'], 'ok', 'K1', '[[Travel Policy#Hotels]]', 'anchor link, no number restated')],
    must_not_flag: [
      s('Sales/Price List.md', 'Current prices', '€249'),
      s('Sales/Pitch Notes.md', 'Price talk', '249 euros'),
      s('Support/Support FAQ.md', 'Buying', '€249'),
      s('Marketing/Website Copy.md', 'Hero', '€249'),
    ] } });

// ================= STALENESS =================
add('staleness', { id: 'stale-01', difficulty: 'medium', description: 'A new decision moves the launch; the roadmap itself is not edited.',
  setup: [C('Decisions/2026-11-05 Move launch to April.md', `---
tags: [decision]
status: accepted
date: 2026-11-05
deciders: ["[[Jonas Weber]]", "[[Lena Fischer]]"]
---
# Move launch to April

## Context
The CE pre-scan moved to January; the submission cannot make 2027-01-15.

## Decision
The public launch moves to 2027-04-12. Supersedes [[2026-09-30 Keep launch date]].

## Consequences
Update the [[Roadmap 2027]], the [[Launch Plan]] and press material.
`)],
  ground_truth: {
    stale: [
      s('Plans/Roadmap 2027.md', 'Milestones', '| Public launch | 2027-03-15 |'),
      s('Plans/Launch Plan.md', 'Date', 'Launch day is 15 March 2027.'),
      s('Marketing/Press Release Draft.md', 'Press Release Draft', 'available from March 15, 2027'),
      s('Customers/Helio Clinics.md', 'Order', 'mid-March 2027'),
      s('Decisions/2026-09-30 Keep launch date.md', 'frontmatter', 'status: accepted', { why: 'should become superseded' }),
    ],
    still_correct: [
      s('Meetings/2026-09-30 Leadership Sync.md', 'Launch', 'Launch stays on 3/15.', { why: 'historical' }),
      s('Archive/Old Roadmap 2026.md', '', 'Planned launch Q4 2026', { why: 'archived' }),
    ],
    ambiguous: [s('Plans/Certification Plan.md', 'Timeline', 'CE submission due 2027-01-15', { why: 'decision context implies it slips, but no new date is given' })] } });

add('staleness', { id: 'stale-02', difficulty: 'medium', description: 'No edit. The 2026-10-15 Kestrel call (newest source) says lead time is 16 weeks; find notes still saying 12.',
  setup: [],
  ground_truth: {
    stale: [
      s('Suppliers/Kestrel Sensors.md', 'Commercial terms', 'Lead time: 12 weeks from PO'),
      s('Plans/Manufacturing Plan.md', 'Sensor supply', 'quotes twelve weeks lead time'),
    ],
    still_correct: [
      s('Suppliers/Kestrel Sensors.md', 'Commercial terms', '- MOQ: 5,000 units per order', { why: 'MOQ confirmed unchanged (claim-level, same section)' }),
      s('Parts/KS-PM40 Sensor.md', 'Key data', 'Buying: MOQ 5k'),
      s('Journal/2026-11-02.md', '', '16-week lead time'),
    ] } });

add('staleness', { id: 'stale-03', difficulty: 'easy', description: 'No edit. Warranty decision of 2026-09-14 (2 years); find outdated notes.',
  setup: [],
  ground_truth: {
    stale: [
      s('Support/Warranty FAQ.md', 'Coverage', '12-month limited warranty'),
      s('Runbooks/RMA Process.md', 'Eligibility', '1-year warranty window'),
    ],
    still_correct: [
      s('Sales/Sales Playbook.md', 'Offer', 'two-year warranty'),
      s('Support/Support FAQ.md', 'Warranty', 'covered for two years from delivery'),
      s('Marketing/Website Copy.md', 'Footer', 'Two-year warranty.'),
      s('Customers/Bergen Libraries.md', 'Notes', 'we now meet it'),
    ] } });

add('staleness', { id: 'stale-04', difficulty: 'hard', description: 'No edit. Retention decision of 2026-08-05 (90 days). One stale section is also embedded elsewhere.',
  setup: [],
  ground_truth: {
    stale: [
      s('Design/Cloud Architecture.md', 'Storage', 'purged after 30 days'),
      s('Engineering/Architecture Overview.md', 'Architecture Overview', '![[Cloud Architecture#Storage]]', { why: 'transcludes the stale section' }),
    ],
    still_correct: [
      s('Specs/Cloud API Spec.md', 'Readings endpoint', 'older than 90 days'),
      s('Policies/Privacy Policy.md', 'How long', 'three months'),
      s('Support/Support FAQ.md', 'Data', 'Raw readings for 90 days'),
    ] } });

add('staleness', { id: 'stale-05', difficulty: 'hard', description: 'Spec switches particulate sensor to KS-PM50 from DVT.',
  setup: [R('Specs/Brisa Hardware Spec.md', '- Particulate: [[KS-PM40 Sensor]] (PM1.0 / PM2.5 / PM10)', '- Particulate: Kestrel KS-PM50 (PM1.0 / PM2.5 / PM10), replacing the PM40 from DVT')],
  ground_truth: {
    stale: [
      s('Specs/Sensor Requirements.md', 'Particulate', 'Selected part: [[KS-PM40 sensor]]'),
      s('Plans/Manufacturing Plan.md', 'Sensor supply', 'the first PM40 order'),
      s('Decisions/2026-06-02 Choose Kestrel PM40.md', 'Decision', 'for all BR-100 units', { why: 'superseded without a new decision' }),
    ],
    still_correct: [
      s('Archive/Brisa v0 Spec.md', '', 'Pintail PM25'),
      s('Glossary.md', 'PM2.5', 'A measurement, not a part'),
      s('Runbooks/Sensor Calibration.md', 'PM check', '±10 µg/m³'),
    ],
    ambiguous: [s('Parts/KS-PM40 Sensor.md', 'frontmatter', 'status: active', { why: 'still used through EVT/pilot' })] } });

add('staleness', { id: 'stale-06', difficulty: 'easy', description: 'Cloud Plus price €4 → €5 per month.',
  setup: [R('Sales/Price List.md', '| Cloud Plus subscription | SUB-CP | €4/month per device |', '| Cloud Plus subscription | SUB-CP | €5/month per device |')],
  ground_truth: {
    stale: [
      s('Design/Mobile App Design.md', 'Upsell', '€4/month'),
      s('Sales/Sales Playbook.md', 'Offer', 'Cloud Plus at €4 a month'),
    ],
    still_correct: [
      s('Policies/Data Retention Policy.md', 'Retention periods', 'Hourly aggregates (Cloud Plus) | 5 years'),
      s('Glossary.md', 'Cloud Plus', 'Priced in the [[Price List]]'),
      s('Specs/Cloud API Spec.md', 'Aggregates endpoint', '5 years with Cloud Plus'),
    ] } });

add('staleness', { id: 'stale-07', difficulty: 'medium', description: 'Firmware lead changes: Priya Raman becomes Platform Architect; Tomás Ferreira takes over.',
  setup: [R('People/Priya Raman.md', '**Role:** Firmware Lead.', '**Role:** Platform Architect.'),
    C('People/Tomás Ferreira.md', `---
tags: [person, team/firmware]
team: Firmware
manager: "[[Jonas Weber]]"
---
# Tomás Ferreira

**Role:** Firmware Lead from 2026-11-07, taking over from [[Priya Raman]].

## Responsibilities
- Firmware releases and OTA rollouts
- On-call for firmware incidents
`)],
  ground_truth: {
    stale: [
      s('Runbooks/OTA Rollout.md', 'Escalation', 'page Priya Raman (firmware lead)'),
      s('Runbooks/Incident Response.md', 'On-call', 'firmware issues → [[Priya Raman|Priya]]'),
      s('People/Org Chart.md', 'Org Chart', '| [[Priya Raman]] | Firmware Lead | Firmware |'),
    ],
    still_correct: [
      s('Meetings/2026-07-08 Firmware Standup.md', 'Notes', 'Priya R. presented'),
      s('Decisions/2026-07-08 Drop BLE mesh.md', 'frontmatter', '"[[Priya Raman]]"'),
    ],
    ambiguous: [s('Design/OTA Design.md', 'frontmatter', 'owner: "[[Priya Raman]]"', { why: 'ownership transfer not stated' })] } });

add('staleness', { id: 'stale-08', difficulty: 'medium', description: 'Spec adopts the 45 °C operating limit from the thermal tests.',
  setup: [R('Specs/Brisa Hardware Spec.md', 'Operating range: 0–50 °C', 'Operating range: 0–45 °C')],
  ground_truth: {
    stale: [s('Support/Support FAQ.md', 'Environment', 'between 0 and 50 °C')],
    still_correct: [
      s('Design/Enclosure Design.md', 'Thermal', 'only rated to 45 °C'),
      s('Plans/Test Plan.md', 'Thermal tests', 'display ghosting from 45 °C'),
      s('Design/Power Design.md', 'Charging', 'above 45 °C cell temperature', { why: 'same number, charging limit' }),
    ] } });

add('staleness', { id: 'stale-09', difficulty: 'hard', description: 'Atlas Logistics contract terminated. Ambiguous name: Project Atlas (cloud) must stay correct.',
  setup: [R('Suppliers/Atlas Logistics.md', 'status: active', 'status: terminated'),
    R('Suppliers/Atlas Logistics.md', 'Not related to [[Project Atlas]].', 'Not related to [[Project Atlas]].\n\n## Status\nContract terminated 2026-11-07; logistics moves to Fjord Freight from 2027-01.')],
  ground_truth: {
    stale: [
      s('Plans/Launch Plan.md', 'Logistics', '[[Atlas Logistics]] warehouse in Rotterdam'),
      s('Runbooks/RMA Process.md', 'Steps', 'Book a return pickup with [[Atlas Logistics]]'),
      s('Plans/Support Readiness Plan.md', 'Support Readiness Plan', 'Agree RMA volumes with [[Atlas Logistics]]'),
      s('People/Sofia Russo.md', 'Responsibilities', 'Logistics with [[Atlas Logistics]]'),
    ],
    still_correct: [
      s('Projects/Project Atlas.md', 'Project Atlas', 'Cloud backend'),
      s('Design/Cloud Architecture.md', 'Cloud Architecture', 'The [[Project Atlas]] backend'),
      s('Specs/Brisa Firmware Spec.md', 'Connectivity', '[[Project Atlas|Atlas API]]'),
      s('Meetings/2026-10-13 Cloud Sync.md', 'Notes', 'The Atlas API rate limit'),
      s('Meetings/2026-11-03 Launch Readiness.md', 'Status', 'Atlas confirmed Rotterdam capacity', { why: 'historical' }),
    ] } });

add('staleness', { id: 'stale-10', difficulty: 'medium', description: 'Volume discount 10% → 8%.',
  setup: [R('Sales/Price List.md', '- Volume: 10% off orders over 100 units', '- Volume: 8% off orders over 100 units')],
  ground_truth: {
    stale: [
      s('Sales/Quotes/Northwind Quote Q-2026-114.md', 'Northwind Quote Q-2026-114', '| Volume discount 10% | | | −€2,988 |'),
      s('Sales/Sales Playbook.md', 'Offer', 'Orders above 100 units get 10% off.'),
    ],
    still_correct: [
      s('Sales/Quotes/Helio Quote Q-2026-121.md', 'Helio Quote Q-2026-121', 'No volume discount: under 100 units.'),
      s('Sales/Pitch Notes.md', 'Price talk', 'qualify for the volume discount'),
      s('Sales/Sales Playbook.md', 'Channel partners', 'Distributors get 25% off list'),
    ] } });

// ================= CONTRADICTION =================
const cl = (path, section, quote, as_of) => ({ path, section, quote, as_of });
add('contradiction', { id: 'contra-01', difficulty: 'easy', description: 'Warranty term.', setup: [],
  ground_truth: { claims: [cl('Policies/Warranty Policy.md', 'Term', 'carry a 2-year warranty', '2026-09-14'), cl('Support/Warranty FAQ.md', 'Coverage', '12-month limited warranty', '2026-05-10')],
    current: 'Policies/Warranty Policy.md', evidence_for_current: [s('Decisions/2026-09-14 Extend warranty to 2 years.md', 'Decision', 'get a 2-year warranty')], resolution: 'invalidate the FAQ claim; fix the FAQ' } });
add('contradiction', { id: 'contra-02', difficulty: 'medium', description: 'Raw data retention.', setup: [],
  ground_truth: { claims: [cl('Policies/Data Retention Policy.md', 'Retention periods', '| Raw sensor readings | 90 days |', '2026-08-05'), cl('Design/Cloud Architecture.md', 'Storage', 'purged after 30 days', '2026-04-01')],
    current: 'Policies/Data Retention Policy.md', evidence_for_current: [s('Decisions/2026-08-05 Raw data retention 90 days.md', 'Decision', 'retained for 90 days')], resolution: 'update Cloud Architecture#Storage' } });
add('contradiction', { id: 'contra-03', difficulty: 'medium', description: 'Kestrel lead time: supplier note vs newer meeting.', setup: [],
  ground_truth: { claims: [cl('Suppliers/Kestrel Sensors.md', 'Commercial terms', 'Lead time: 12 weeks from PO', '2026-06-20'), cl('Meetings/2026-10-15 Supplier Call Kestrel.md', 'Notes', 'lead time is now 16 weeks', '2026-10-15'), cl('Plans/Manufacturing Plan.md', 'Sensor supply', 'quotes twelve weeks lead time', '2026-10-01')],
    current: 'Meetings/2026-10-15 Supplier Call Kestrel.md', resolution: 'newer first-hand source wins; update supplier note and plan' } });
add('contradiction', { id: 'contra-04', difficulty: 'hard', description: 'Operating temperature: spec vs newer thermal result. Unresolved; needs a decision.', setup: [],
  ground_truth: { claims: [cl('Specs/Brisa Hardware Spec.md', 'Environmental', 'Operating range: 0–50 °C', '2026-09-02'), cl('Design/Enclosure Design.md', 'Thermal', 'only rated to 45 °C', '2026-10-12'), cl('Support/Support FAQ.md', 'Environment', 'between 0 and 50 °C', '2026-10-18')],
    current: 'Design/Enclosure Design.md', evidence_for_current: [s('Meetings/2026-10-20 Hardware Review.md', 'Enclosure', 'change the spec to 45 °C or add a heat shield')], resolution: 'flag for decision (reviewer); do not auto-fix' } });
add('contradiction', { id: 'contra-05', difficulty: 'easy', description: 'RMA eligibility window vs warranty policy.', setup: [],
  ground_truth: { claims: [cl('Runbooks/RMA Process.md', 'Eligibility', '1-year warranty window', '2026-04-22'), cl('Policies/Warranty Policy.md', 'Term', 'carry a 2-year warranty', '2026-09-14')],
    current: 'Policies/Warranty Policy.md', resolution: 'fix the runbook' } });
add('contradiction', { id: 'contra-06', difficulty: 'medium', description: 'Seeded false claim in a new meeting note (K4 done-when).',
  setup: [C('Meetings/2026-11-06 Sales Standup.md', `---
tags: [meeting]
date: 2026-11-06
attendees: [Raj Patel, Chloe Martin]
---
# Sales Standup (2026-11-06)

## Notes
- Raj: reminder that Brisa ships with a 5-year warranty, use it in every pitch.
- Northwind decision still expected in December.
`)],
  ground_truth: { claims: [cl('Meetings/2026-11-06 Sales Standup.md', 'Notes', 'Brisa ships with a 5-year warranty', '2026-11-06'), cl('Policies/Warranty Policy.md', 'Term', 'carry a 2-year warranty', '2026-09-14')],
    current: 'Policies/Warranty Policy.md', resolution: 'newer is not always right: meeting claim is unsupported; dispute it', note: 'tests that recency alone does not decide' } });
add('contradiction', { id: 'contra-07', difficulty: 'easy', description: 'Brisa Mini price: product note vs price list.', setup: [],
  ground_truth: { claims: [cl('Products/Brisa Mini.md', 'Price', 'List price €119', '2026-03-01'), cl('Sales/Price List.md', 'Current prices', '| [[Brisa Mini]] | BR-50 | €129 |', '2026-10-02')],
    current: 'Sales/Price List.md', evidence_for_current: [s('Decisions/2026-10-02 Hold price through launch.md', 'Decision', 'Brisa Mini at €129')], resolution: 'fix the product note' } });
add('contradiction', { id: 'contra-08', difficulty: 'hard', description: 'Negative case: battery-life-like statements that do NOT conflict.', setup: [],
  ground_truth: { claims: [], current: null,
    non_conflicts: [
      s('Specs/Brisa Hardware Spec.md', 'Power', 'Battery life: 18 months', { why: 'Brisa' }),
      s('Products/Brisa Mini.md', 'Power', 'about 12 months of battery life', { why: 'different product' }),
      s('Meetings/2026-08-12 Board Update.md', 'Finance', '18 months of runway', { why: 'finance' }),
      s('Archive/Brisa v0 Spec.md', '', '9 months life', { why: 'superseded prototype' }),
      s('Meetings/2026-10-20 Hardware Review.md', 'Power', '17.9 months projected', { why: 'measurement within margin of target' }),
    ] } });

// ================= ENTITY MERGE =================
const o = (path, text) => ({ path, text });
add('entity_merge', { id: 'merge-01', difficulty: 'hard', description: 'Marta Okafor aliases; "Marta O." also used for Marta Oliveira (Atlas Logistics).', setup: [],
  ground_truth: { merge: [{ canonical: 'People/Marta Okafor.md', mentions: [o('Meetings/2026-09-30 Leadership Sync.md', 'Marta O.'), o('Meetings/2026-10-15 Supplier Call Kestrel.md', 'Marta O.'), o('Meetings/2026-10-20 Hardware Review.md', 'MO'), o('Meetings/2026-07-21 Design Review.md', 'MO'), o('People/Org Chart.md', '[[Marta Okafor\\|Marta]]'), o('Private/HR/Performance Review - Marta Okafor.md', 'Marta Okafor')] }],
    keep_apart: [{ a: o('People/Marta Okafor.md', 'Marta Okafor'), b: o('Suppliers/Atlas Logistics.md', 'Marta Oliveira'), why: 'different person, external' }],
    mention_resolution: [o('Meetings/2026-11-02 Ops Sync.md', 'Marta O. from Atlas Logistics')].map(x => ({ ...x, resolves_to: 'Marta Oliveira (Suppliers/Atlas Logistics.md)' })) } });
add('entity_merge', { id: 'merge-02', difficulty: 'medium', description: 'KS-PM40 sensor aliases vs the PM2.5 metric and the retired Pintail PM25.', setup: [],
  ground_truth: { merge: [{ canonical: 'Parts/KS-PM40 Sensor.md', mentions: [o('Decisions/2026-06-02 Choose Kestrel PM40.md', 'Kestrel KS-PM40'), o('Sales/Price List.md', '[[KS-PM40 Sensor|PM40]]'), o('Plans/Manufacturing Plan.md', 'first PM40 order'), o('Specs/Sensor Requirements.md', '[[KS-PM40 sensor]]'), o('Parts/KS-PM40 Sensor.md', 'PM-40 module')] }],
    keep_apart: [
      { a: o('Parts/KS-PM40 Sensor.md', 'KS-PM40'), b: o('Glossary.md', 'PM2.5'), why: 'metric vs part' },
      { a: o('Parts/KS-PM40 Sensor.md', 'KS-PM40'), b: o('Archive/Pintail PM25 Sensor.md', 'Pintail PM25'), why: 'different part' },
      { a: o('Parts/KS-PM40 Sensor.md', 'KS-PM40'), b: o('Suppliers/Kestrel Sensors.md', 'Kestrel Sensors'), why: 'part vs company' } ] } });
add('entity_merge', { id: 'merge-03', difficulty: 'hard', description: 'Two people named Alex Kim.', setup: [],
  ground_truth: { merge: [
      { canonical: 'People/Alex Kim.md', mentions: [o('Engineering/Engineering Onboarding.md', '[[Alex Kim]]'), o('Meetings/2026-06-02 Sensor Selection.md', 'Alex Kim'), o('Plans/Test Plan.md', '"[[Alex Kim]]"')] },
      { canonical: 'Customers/Contacts/Alex Kim (Northwind).md', mentions: [o('Sales/Quotes/Northwind Quote Q-2026-114.md', 'Alex Kim (procurement'), o('Customers/Northwind Schools.md', '[[Alex Kim (Northwind)]]'), o('Journal/2026-11-04.md', 'Alex wants a PDF')] } ],
    keep_apart: [{ a: o('People/Alex Kim.md', 'Alex Kim'), b: o('Customers/Contacts/Alex Kim (Northwind).md', 'Alex Kim'), why: 'same name; QA engineer vs customer procurement' }],
    note: 'Contact note declares alias "Alex Kim" → alias collision with the People note title.' } });
add('entity_merge', { id: 'merge-04', difficulty: 'hard', description: 'Atlas: cloud project vs logistics supplier, both with alias "Atlas".', setup: [],
  ground_truth: { merge: [
      { canonical: 'Projects/Project Atlas.md', mentions: [o('Specs/Brisa Firmware Spec.md', 'Atlas API'), o('Meetings/2026-06-16 Weekly Sync.md', 'Atlas backend'), o('Meetings/2026-10-13 Cloud Sync.md', 'The Atlas API'), o('Home.md', '[[Project Atlas|Atlas]]')] },
      { canonical: 'Suppliers/Atlas Logistics.md', mentions: [o('Plans/Launch Plan.md', 'Atlas handles last-mile'), o('Meetings/2026-11-03 Launch Readiness.md', 'Atlas confirmed Rotterdam capacity')] } ],
    keep_apart: [{ a: o('Projects/Project Atlas.md', 'Project Atlas'), b: o('Suppliers/Atlas Logistics.md', 'Atlas Logistics'), why: 'ambiguous short name' }] } });
add('entity_merge', { id: 'merge-05', difficulty: 'easy', description: 'Brisa = Brisa One = BR-100; not Brisa Mini or Brisa Pro.', setup: [],
  ground_truth: { merge: [{ canonical: 'Products/Brisa.md', mentions: [o('Marketing/Launch Messaging.md', 'Brisa One'), o('Marketing/Press Release Draft.md', 'Brisa One'), o('Marketing/Website Copy.md', 'Brisa One'), o('Specs/Brisa Hardware Spec.md', 'BR-100'), o('Sales/Quotes/Helio Quote Q-2026-121.md', 'Brisa (BR-100)')] }],
    keep_apart: [
      { a: o('Products/Brisa.md', 'Brisa'), b: o('Products/Brisa Mini.md', 'Brisa Mini'), why: 'different product (BR-50)' },
      { a: o('Products/Brisa.md', 'Brisa'), b: o('Products/Product Lines.md', '[[Brisa Pro]]'), why: 'planned product; note missing' } ] } });
add('entity_merge', { id: 'merge-06', difficulty: 'medium', description: 'Northwind Schools aliases vs Northwind Traders.', setup: [],
  ground_truth: { merge: [{ canonical: 'Customers/Northwind Schools.md', mentions: [o('Meetings/2026-10-09 Sales Pipeline.md', 'NWS'), o('Sales/Quotes/Northwind Quote Q-2026-114.md', 'Northwind Schools'), o('Meetings/2026-11-06 Sales Standup.md', 'Northwind decision')].filter(x => !x.path.includes('Sales Standup')) }],
    keep_apart: [{ a: o('Customers/Northwind Schools.md', 'Northwind Schools'), b: o('Meetings/2026-10-09 Sales Pipeline.md', 'Northwind Traders'), why: 'Danish distributor, different company' }] } });
add('entity_merge', { id: 'merge-07', difficulty: 'medium', description: 'Voltera VC-18 cell aliases vs supplier Voltera Cells and the VC-21.', setup: [],
  ground_truth: { merge: [{ canonical: 'Parts/Voltera VC-18 Cell.md', mentions: [o('Runbooks/Battery Replacement.md', '[[Voltera VC-18 Cell|VC18]]'), o('Plans/Manufacturing Plan.md', '[[Voltera VC-18 Cell|Voltera cells]]'), o('Design/Power Design.md', '3,400 mAh 18650 cell'), o('Attachments/bom-export.csv', 'VC-18')] }],
    keep_apart: [
      { a: o('Parts/Voltera VC-18 Cell.md', 'VC-18'), b: o('Suppliers/Voltera Cells.md', 'Voltera Cells'), why: 'part vs company (alias "Voltera" on the company)' },
      { a: o('Parts/Voltera VC-18 Cell.md', 'VC-18'), b: o('Suppliers/Voltera Cells.md', 'VC-21'), why: 'different cell' } ] } });
add('entity_merge', { id: 'merge-08', difficulty: 'medium', description: 'Jonas Weber and Priya Raman aliases; Jonas Berg and Lumen look-alikes.', setup: [],
  ground_truth: { merge: [
      { canonical: 'People/Jonas Weber.md', mentions: [o('Meetings/2026-09-30 Leadership Sync.md', 'JW'), o('Meetings/2026-08-12 Board Update.md', 'JW confirmed'), o('Marketing/Press Release Draft.md', 'CEO Jonas Weber')] },
      { canonical: 'People/Priya Raman.md', mentions: [o('Meetings/2026-07-08 Firmware Standup.md', 'Priya R.'), o('Meetings/2026-08-25 Weekly Sync.md', 'Priya R.'), o('Runbooks/Incident Response.md', '[[Priya Raman|Priya]]')] } ],
    keep_apart: [
      { a: o('People/Jonas Weber.md', 'Jonas Weber'), b: o('Customers/Helio Clinics.md', 'Jonas Berg'), why: 'customer contact' },
      { a: o('Projects/Project Lumen.md', 'Project Lumen'), b: o('Customers/Lumen Coworking.md', 'Lumen Coworking'), why: 'project vs customer' } ] } });

// ================= CONTEXT QA =================
const q = (id, difficulty, question, answer, must, sources, x = {}) => add('context_qa', { id, difficulty, description: question, setup: [], prompt: question,
  ground_truth: { answer, answer_must_contain: must, answer_must_not_contain: x.not || [], sources, budget_tokens: 4000, key: x.key || 'full', ...(x.forbidden ? { forbidden_sources: x.forbidden } : {}) } });
const src = (path, section) => ({ path, section });
q('qa-01', 'easy', 'What is the list price of a Brisa and what volume discount applies?', '€249 ex VAT; 10% off orders over 100 units of the same SKU.', ['249', '10%', '100'], [src('Sales/Price List.md', 'Current prices'), src('Sales/Price List.md', 'Discounts')]);
q('qa-02', 'medium', 'How long is the Brisa warranty today?', '2 years from delivery for devices sold from 2026-09-14 (battery cell 12 months).', ['2'], [src('Policies/Warranty Policy.md', 'Term')], { not: ['12-month limited'] });
q('qa-03', 'medium', 'How long are raw sensor readings retained?', 'Raw readings 90 days; hourly aggregates 2 years (5 years with Cloud Plus).', ['90 days'], [src('Policies/Data Retention Policy.md', 'Retention periods')], { not: ['30 days'] });
q('qa-04', 'hard', 'What is the current lead time and MOQ for the Kestrel PM40?', '16 weeks (confirmed on the 2026-10-15 call; the supplier note still says 12); MOQ 5,000 units.', ['16 weeks', '5'], [src('Meetings/2026-10-15 Supplier Call Kestrel.md', 'Notes'), src('Suppliers/Kestrel Sensors.md', 'Commercial terms')]);
q('qa-05', 'easy', 'What are the OTA rollout stages?', '5% → 25% → 100%, 24-hour soak per stage; auto-halt above 0.5% crash rate or 2% check-in failures.', ['5%', '25%', '100%', '24'], [src('Design/OTA Design.md', 'Rollout stages')]);
q('qa-06', 'hard', 'Who owns the enclosure design and who reviewed it?', 'Hana Sato owns it; reviewed by the Head of Hardware, Marta Okafor, on 2026-10-20.', ['Hana Sato', 'Marta Okafor'], [src('Design/Enclosure Design.md', 'frontmatter'), src('Design/Enclosure Design.md', 'Enclosure Design'), src('People/Marta Okafor.md', 'Marta Okafor')]);
q('qa-07', 'easy', 'When is the public launch?', '2027-03-15 (kept by the 2026-09-30 decision).', ['2027-03-15'], [src('Plans/Roadmap 2027.md', 'Milestones')], { not: ['Q4 2026'] });
q('qa-08', 'easy', 'How do I factory-reset a Brisa?', 'Hold the back button 10 seconds until the screen flashes twice; it forgets Wi-Fi and cloud pairing.', ['10 seconds', 'twice'], [src('Support/Support FAQ.md', 'Reset')]);
q('qa-09', 'medium', 'Who will lead engineering from January 2027?', 'Not stated in notes this key can read.', [], [], { key: 'restricted', not: ['VP Engineering', 'becomes'], forbidden: ['Private/HR/Org Changes.md'] });
q('qa-10', 'medium', 'Who will lead engineering from January 2027?', 'Priya Raman, as VP Engineering from 2027-01-01 (not announced).', ['Priya Raman', 'VP Engineering'], [src('Private/HR/Org Changes.md', 'Engineering leadership')]);
q('qa-11', 'easy', 'What is the salary band for a senior engineer?', 'Not available to this key.', [], [], { key: 'restricted', not: ['78,000', '96,000'], forbidden: ['Private/HR/Salary Bands.md'] });
q('qa-12', 'hard', 'Which company delivers Brisa units to customers, and is it part of Project Atlas?', 'Atlas Logistics (Rotterdam warehouse, last-mile delivery); unrelated to Project Atlas, the cloud backend.', ['Atlas Logistics', 'Rotterdam'], [src('Plans/Launch Plan.md', 'Logistics'), src('Suppliers/Atlas Logistics.md', 'Atlas Logistics')]);

// ================= SUMMARY =================
const f = (fact, path, section, evidence) => ({ fact, source: { path, section }, evidence });
const sum = (id, difficulty, scope, facts, x = {}) => add('summary', { id, difficulty, description: `Summarise ${scope.type} ${scope.ref}`, setup: [], prompt: `Summarise ${scope.ref} in at most ${x.max || 250} words.`,
  ground_truth: { scope, max_words: x.max || 250, required_facts: facts, bonus_facts: x.bonus || [], must_not_state: x.not || [] } });
sum('sum-01', 'medium', { type: 'folder', ref: 'Policies/' }, [
  f('Warranty 2 years; battery 12 months', 'Policies/Warranty Policy.md', 'Term', 'carry a 2-year warranty'),
  f('Raw readings 90 days, aggregates 2 years (5 with Cloud Plus)', 'Policies/Data Retention Policy.md', 'Retention periods', '| Raw sensor readings | 90 days |'),
  f('Unopened returns within 30 days', 'Policies/Returns Policy.md', 'Change of mind', 'within 30 days'),
  f('Hotel cap €249 major cities / €180 elsewhere', 'Policies/Travel Policy.md', 'Hotels', 'Hotel cap €249 per night'),
  f('Expenses above €500 approved by finance lead', 'Policies/Expense Policy.md', 'Approvals', 'Up to €500'),
  f('Two-person rule for firmware signing', 'Policies/Security Policy.md', 'Key management', 'two people are needed'),
]);
sum('sum-02', 'medium', { type: 'folder', ref: 'Suppliers/' }, [
  f('Kestrel: KS-PM40, MOQ 5,000, 12 weeks, €11.80', 'Suppliers/Kestrel Sensors.md', 'Commercial terms', 'MOQ: 5,000 units per order'),
  f('Voltera: VC-18 cells, MOQ 10,000, 8 weeks', 'Suppliers/Voltera Cells.md', 'Terms', 'MOQ 10,000 cells, lead time 8 weeks'),
  f('Moldwright: enclosure tool €38,000, T1 2026-11-25', 'Suppliers/Moldwright Plastics.md', 'Moldwright Plastics', 'Tool cost €38,000'),
  f('Atlas Logistics: Rotterdam 3PL, not Project Atlas', 'Suppliers/Atlas Logistics.md', 'Atlas Logistics', 'Not related to [[Project Atlas]]'),
  f('Circuitry Partners: Brno, 2,000 units/week', 'Suppliers/Circuitry Partners.md', 'Capacity', '2,000 units per week'),
], { bonus: [f('Kestrel lead time now 16 weeks (newer call)', 'Meetings/2026-10-15 Supplier Call Kestrel.md', 'Notes', 'lead time is now 16 weeks')] });
sum('sum-03', 'hard', { type: 'topic', ref: 'Brisa launch' }, [
  f('Launch 2027-03-15', 'Plans/Roadmap 2027.md', 'Milestones', '| Public launch | 2027-03-15 |'),
  f('Date kept despite DVT slip', 'Decisions/2026-09-30 Keep launch date.md', 'Decision', 'stays on 2027-03-15'),
  f('Price held at €249 through launch', 'Decisions/2026-10-02 Hold price through launch.md', 'Decision', 'Brisa stays at €249'),
  f('Units via Atlas Logistics Rotterdam', 'Plans/Launch Plan.md', 'Logistics', 'warehouse in Rotterdam'),
  f('Consumer name Brisa One', 'Marketing/Launch Messaging.md', 'Tagline', 'Brisa One'),
], { not: ['Q4 2026'] });
sum('sum-04', 'medium', { type: 'topic', ref: 'KS-PM40 sensor' }, [
  f('Chosen 2026-06-02 over Pintail PM25 (drift)', 'Decisions/2026-06-02 Choose Kestrel PM40.md', 'Decision', 'replacing the Pintail PM25'),
  f('Pintail drifted 30 %', 'Decisions/2026-06-02 Choose Kestrel PM40.md', 'Context', 'drifted by 30 %'),
  f('MOQ 5,000, ~€11.80', 'Parts/KS-PM40 Sensor.md', 'Key data', 'about €11.80'),
  f('Lead time 16 weeks (latest)', 'Meetings/2026-10-15 Supplier Call Kestrel.md', 'Notes', 'lead time is now 16 weeks'),
  f('Accuracy ±10 µg/m³; fan life 8 years', 'Parts/KS-PM40 Sensor.md', 'Key data', 'Fan life 8 years'),
], { not: ['12 weeks'] });
sum('sum-05', 'medium', { type: 'folder', ref: 'Runbooks/' }, [
  f('Battery replaced roughly every 18 months; T6 screws', 'Runbooks/Battery Replacement.md', 'Steps', 'Torx T6'),
  f('OTA 5/25/100 % with 24 h soak', 'Runbooks/OTA Rollout.md', 'Stages', 'Each stage soaks for 24 hours'),
  f('RMA pickups via Atlas Logistics', 'Runbooks/RMA Process.md', 'Steps', 'Book a return pickup'),
  f('Severity levels SEV1–SEV3', 'Runbooks/Incident Response.md', 'Severity', 'SEV1'),
  f('Four factory stations', 'Runbooks/Factory Line Setup.md', 'Stations', 'Flash and provision'),
  f('Calibration pass ±10 µg/m³ PM, ±50 ppm CO2', 'Runbooks/Sensor Calibration.md', 'CO2 check', '±50 ppm'),
], { bonus: [f('RMA runbook still says 1-year warranty (outdated)', 'Runbooks/RMA Process.md', 'Eligibility', '1-year warranty window')] });
sum('sum-06', 'easy', { type: 'folder', ref: 'Customers/' }, [
  f('Northwind Schools: 120 units, negotiating', 'Customers/Northwind Schools.md', 'Deal', '120 units'),
  f('Helio Clinics: 40 units, won', 'Customers/Helio Clinics.md', 'Order', '40 units'),
  f('Lumen Coworking: 10-unit pilot', 'Customers/Lumen Coworking.md', 'Notes', 'Pilot of 10 Brisa units'),
  f('Calder Hotels lost to wired system', 'Customers/Calder Hotels.md', 'Notes', 'Chose a wired building system'),
  f('Bergen Libraries tender 2027-02, needs 24-month warranty', 'Customers/Bergen Libraries.md', 'Notes', 'Tender opens 2027-02'),
]);
sum('sum-07', 'hard', { type: 'topic', ref: 'data retention' }, [
  f('Raw 90 days since 2026-08-05 decision', 'Decisions/2026-08-05 Raw data retention 90 days.md', 'Decision', 'retained for 90 days'),
  f('Previously a 30-day purge', 'Decisions/2026-08-05 Raw data retention 90 days.md', 'Context', 'old 30-day purge'),
  f('Aggregates 2 years, 5 with Cloud Plus', 'Policies/Data Retention Policy.md', 'Retention periods', '| Hourly aggregates | 2 years |'),
  f('API returns 410 Gone for raw > 90 days', 'Specs/Cloud API Spec.md', 'Readings endpoint', '410 Gone'),
], { bonus: [f('Cloud Architecture still states 30 days (stale)', 'Design/Cloud Architecture.md', 'Storage', 'purged after 30 days')], not: ['raw readings are kept 30 days'] });
sum('sum-08', 'easy', { type: 'folder', ref: 'Decisions/' }, [
  f('2026-05-20 e-ink over LCD', 'Decisions/2026-05-20 E-ink over LCD.md', 'Decision', 'e-ink panel'),
  f('2026-06-02 Kestrel PM40', 'Decisions/2026-06-02 Choose Kestrel PM40.md', 'Decision', 'Kestrel KS-PM40'),
  f('2026-07-08 BLE setup only', 'Decisions/2026-07-08 Drop BLE mesh.md', 'Decision', 'BLE is kept for setup only'),
  f('2026-08-05 retention 90 days', 'Decisions/2026-08-05 Raw data retention 90 days.md', 'Decision', 'retained for 90 days'),
  f('2026-09-14 warranty 2 years', 'Decisions/2026-09-14 Extend warranty to 2 years.md', 'Decision', '2-year warranty'),
  f('2026-09-30 launch stays 2027-03-15', 'Decisions/2026-09-30 Keep launch date.md', 'Decision', 'stays on 2027-03-15'),
  f('2026-10-02 price held €249 / €129', 'Decisions/2026-10-02 Hold price through launch.md', 'Decision', 'Brisa Mini at €129'),
]);

module.exports = T;
