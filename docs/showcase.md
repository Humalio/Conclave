# The Early Echo

A listening station receives a reply before it sends its signal. Your job is to find out where the reply came from. Follow the evidence in the vault, compare the teams' explanations, and decide what to investigate next.

Start with [the demo walkthrough](getting-started.md#try-the-early-echo-demo). In the console, open **Explore the case** for the case board, evidence trails, and decisions. The [original case notes](../eval/vault/) are also available in the repository.

## For developers

The fictional investigation runs against a disposable hub. Its scripted agents cover tools, console workflows, and acceptance checks without making model calls. Use the story to populate a [local console](getting-started.md#local-design-review-hub) or run it as a [feature test](#the-story-is-the-feature-test-suite). The runner and its data live in [`eval/`](../eval/), and the [graph benchmark](../bench/README.md) is separate.

## 1. Story bible

> **2191. Relay Tern-9 receives a reply 0.71 seconds before the message is sent.**
> Then it happens on all forty relays.

### The world

- **The Meridian Net.** Forty relay stations strung from Mercury to the Kuiper edge. Every call, trade and heartbeat in the system passes through them.
- **Halcyon Relay Authority** (the Authority). Owns the Net. Polite, rich, and very keen that this is a glitch.
- **The Annex.** The Authority's Office of Anomalous Traffic: three desks in the basement of **Corvel Station**, the ring habitat where the Authority sits. Nobody funds it. Everybody forwards it the weird tickets.
- **Tern-9.** Relay no. 40, the furthest, eleven light-hours out. Four keepers, one cryo-cooled dish. Its relay controller software is **ORRIN**. It is where the echo started.

### The echo

The **echo** is a reply to a relay transmission that arrives **0.71 s before** the transmission leaves the dish. Logged anomalies are numbered "echo N". The first 46 were filed as clock noise. **Echo 47** is the first nobody could explain: the keeper transcript stops mid-sentence ("the reply's already on screen, but I haven't sent—") and the live-listen campaign was paused that day. On echo 47 the relay clock logged the reply twice, once on arrival and once 0.71 s before the send command existed. The team calls this the **second timestamp**.

The echo depends on transmit power (relative, 0 to 1). It appears only above **0.32**. Four subsystems carry the dish:

| Subsystem | What it does | Hard limit the story revolves around |
|---|---|---|
| **Dish array** | A cryo-cooled dish with a feed horn and six cold-face receiver tiles. | Transmit power: the echo appears above 0.32, and the Authority capped every send at 0.30. |
| **Receiver chain and firmware** | Relay firmware (build 7) and ORRIN stamp every send and receive. | Timestamp accuracy. |
| **Power train** | A capacitor bank charges each transmit pulse. | Bank energy and surge margin. |
| **Relay clock** | Stamps sends and receives to within 4 ns. | Clock drift. |

Keepers who sleep near the dish also report hearing the reply in their dreams before it arrives (**echo sleep**). Xenobiology counts the exposure in **echo-hours (EH)**. Shielded bunks are the countermeasure.

### The leads

| Lead | Role |
|---|---|
| **Vesna** (The Annex, believer) | Has a wall of red string at home. Logged every echo for a year before the Authority admitted one. |
| **Halden** (The Annex, skeptic) | A former Authority auditor, sent to the Annex to close it. Reads every source. Hates being right about the wrong thing. |

Their argument is the review loop in Act 2: Vesna submits a theory and Halden sends it back.

### The case

The **Echo Case** is run by the Authority's Case Command with the Authority's oversight board. Its charter is: "Find what is answering the Net before it answers, and keep the Net trusted while we do."

| Milestone | Meaning | Owner |
|---|---|---|
| M1 Echo model frozen | The echo geometry the dish is designed against is fixed. | Signals Lab |
| M2 Dish design review | The dish array design passes review. | Relay Engineering |
| M3 Explanation qualified | The leading explanation (Firmware 7, or its replacement) survives an air-gapped capture. | The Annex |
| M4 Live listen | A full-power transmit-and-listen on the test stand. | Case Command |
| M5 Tern-9 refit complete | Shielded bunks, the dish mount and the receiver swap are installed at Tern-9. | Tern-9 Keepers |
| M6 Disclosure approved | The Disclosure Board approves the disclosure case. | Disclosure Board |
| M7 First deliberate reply | The first reply the Net sends on purpose. It is scheduled, not done, in the story. | Case Command |

### The research disciplines

| Discipline | Questions it answers | Team |
|---|---|---|
| Signals | What geometry and timing does the echo have, and how stable is it? | Signals Lab |
| Relay engineering | Can the dish be driven, held and silenced safely? | Relay Engineering |
| Anomalous traffic | Which explanation survives an independent capture? | The Annex |
| Timekeeping | How precisely do the clocks stamp events, and where does the early reply land? | Timekeepers |
| Xenobiology | What is the frost, and what does echo sleep cost the keepers? | Xenobiology |
| Case command | Do the parts fit together, and when are we ready? | Case Command |
| Disclosure and oversight | Is the disclosure case sound? (Independent review.) | Disclosure Board |
| Station engineering | How is it installed on a relay that was never designed for it? | Tern-9 Keepers |

### The theory wall

Each theory is one note in `Theories/`. In the graph view it is the red-string board: evidence notes pin to theories, and when evidence is debunked, `graph_impact` shows which theories fall.

| Theory | Pushed by | Fate |
|---|---|---|
| **Firmware 7**: a timestamp bug in relay firmware build 7 | The Authority (the official line) | Killed in Act 3 by the air-gapped capture |
| **The future is answering** | Vesna | Survives, unproven |
| **The relay mind is lying**: ORRIN fakes echoes to stay powered | Signals Lab | Killed in Act 3: no ORRIN in the air-gapped loop |
| **The dish is alive**: the frost on Tern-9's dish is learning | Xenobiology | Half true: the frost senses the echo but does not make it (the empty-dish capture) |
| **The hollow-moon lighthouse**: something inside Iapetus is signalling back | The Night Choir (amateur listeners) | Crackpot, yet its timing predictions keep hitting. Never closed. |
| **A weapons test, covered up** | Halden, reluctantly | Closest to the truth: it was a drive test |

### The frost

At 03:40 on 9 April 2191, after a cryo alarm (incident report IR-0412), a keeper found a film of microscopic glassy filaments on the cold receiver face of Tern-9's dish, next to **dish panel 7**. On 11 April she mapped faint frost at nine spots. Catalogue: frost specimen **F-3**. It is an original organism, not based on any existing creature:

- A colony of silica filaments, each a few microns wide.
- Dormant when warm; active below 60 K.
- When active, it ticks and re-forms **0.7 s before** each echo arrives, and gains mass only after transmissions above 0.32.
- Dish panel 7 was fitted in a 2189 refit and appears on no purchase order. Its chain of custody (Classified) shows it came off the Authority's test vessel **HX-2**.

**The disagreement.**

- Xenobiology treats the frost as a contamination hazard. Its notes ask whether it could explain echo sleep.
- Signals Lab treats it as an instrument. Its notes propose wiring a sealed colony into the clock network as a living early-warning sensor.
- The vault answers the contamination question: CAP-014b (empty dish) scrapes the frost off and sterilises the dish, and the echo still arrives. The frost senses the echo but does not make it.

The open question, whether it is right to use a living thing as a sensor, goes to the Disclosure Board. The board's order in Act 5 carries the condition "no frost in the relay loop until the ethics review closes".

### The cover story and the capture

The official explanation is **Firmware 7**: relay firmware build 7 stamps receive times wrong. Blocker B-01 blames a bad build lot from the vendor **Pellam Systems**. That is the cover.

**CAP-014 Air-gapped capture** runs at Tern-9: firmware removed, ORRIN disconnected, a hand-clocked receiver. At the start of the story it is *running, result pending*. In Act 3 the runner rewrites it from outside the hub: the echo still arrived 0.71 s early on 600 of 600 transmissions above 0.32. That kills Firmware 7 and "the relay mind is lying".

The **Q-9 quiet receiver** is firmware-free and hand-clocked, and its front end is shielded outside the **2.3 GHz ring band** where the echo rings receivers. It replaces the Firmware 7 patch. It works because its band sits outside the ring, not because it is better made.

### The secret thread: what answers us

The Net has found something it does not understand, and the Authority has kept it quiet.

**What the public notes say.** The data around echo 47 is partial, and the readable explanations contradict each other:

- Signals Lab's lab notebook (Teodor) blames clock jitter. The Timekeepers' holdover test rules jitter out.
- One page of the live-listen log is redacted.
- Blocker B-01 blames a bad vendor lot of build 7.

**What `Classified/` holds.** In 2189 the Authority secretly ran a **fold test** near Tern-9 with HX-2. The director's memo, *What answers us* (marked "do not circulate"), gives the working explanation:

- The fold touched a structured medium the memo calls the **substrate**, and the substrate **answers**.
- The answer is not bound to our clocks, so it arrives early.
- It rings receivers in the 2.3 GHz band, which the timestamp-fault model never included.

Pellam's own test report on build 7, also in `Classified/`, says build 7 passed: there is no timestamp defect. An intercepted message asks Pellam to "reissue the build 7 release notes with a timestamp defect". The director (**Director Ines Calloway**) chose the cover to keep the Net trusted and funded. Her memo's last line: *"Keep it a glitch until we know what it is answering."* This is why the Act 3 blocker *is* the secret, and why Vesna's `access_request` for `Classified/` (3.9, granted in 4.3) is the reveal.

### Plot in one paragraph

Kickoff sets the plan and the teams. Research gathers theories on the wall, while odd notes hint at echo 47 and a frost nobody will talk about. Then **CAP-014**, the air-gapped capture, returns its result: the echo arrives 0.71 s early with no firmware and no ORRIN in the loop. The result is written into the vault outside the hub, as if from the Tern-9 station PC. The knowledge graph shows that it reaches the Firmware 7 explanation, the dish array design, the power budget, the disclosure case and milestone M4. Work is blocked, one task is cancelled, and the operator decides to listen on the **Q-9 quiet receiver** instead of patching Firmware 7. Vesna's temporary read of `Classified/` then reveals that the "bad build lot" was a cover: the cause is the substrate. In recovery, the teams redesign around Q-9 for the right reason, a reviewer requests changes, a lockdown drill runs, and the outside **Night Choir** joins through onboarding to run the independent capture. In disclosure, the Disclosure Board approves a partial disclosure with a new hazard and the frost condition, the decision is recorded, and the teams that are done complete. The story ends with a Tern-9 station log line: a reply to a message nobody has written yet, dated three days ahead.

## 2. Vault plan (`eval/vault/`)

There are 111 Markdown notes, linked with wikilinks, plus `depends_on:` frontmatter wherever a note uses another note's result. Each note has `owner:` (a team) and `status:` frontmatter, and an H2 section structure so graph claims can cite `path#section`. Two of the notes (Echo model v2 and Disclosure order) are written by the story, not at the start. The folders and planned notes:

| Folder | Notes | Contents |
|---|---|---|
| `Case Command/` | 10 | Case charter, Milestones (M1–M7), Risk register, Decision log, Org chart, Glossary, Schedule, Requirements (R1–R12), Weekly status template, **Case board** (the index of mysteries) |
| `Signals Lab/` | 12 | Echo geometry, Lead time vs transmit power, Stability analysis, Echo decay, Echo model v1, Echo model v2 (written in Act 2), Open questions, two literature notes, **Lab notebook — Teodor** (blames jitter), **Lab notebook — Imani** (doesn't), **Frost as an instrument** |
| `Relay Engineering/` | 10 | Dish array design, Feed horn spec, Power budget, Capacitor bank, Surge protection, Transmit sequence, Cryo plant, Dish test plan, Shielding interface, Dish draft (renamed in Act 2) |
| `The Annex/` | 8 | Q-9 quiet receiver, Case file AT-0412, Capture rig geometry, Timestamp fault model, Signal paths, Dish mount reinforcement, Vendor audit, Annex risks |
| `Timekeepers/` | 9 | Relay clock design, Clock drift model, Lead-time error, Pulsar-fix procedure, Timing chain, Holdover test, Timing risks, Recording notes, **Second timestamp** |
| `Oversight/` | 11 | Disclosure case (§1–§8 at start; §9 "The answer" is added in Act 4), Hazard log (H-01–H-13), Disclosure basis, Independent review rules, Surge hazard, Signal leak hazard, Echo sleep hazard, Emergency silence, Shutdown criteria, **IR-0412 Tern-9 cryo alarm**, Disclosure order (written in Act 5) |
| `Xenobiology/` | 10 | Echo sleep physiology, Exposure limit, Dose model, Keeper screening, Bunk shielding requirements, Countermeasures, Biohazard risks, **Frost feeding log**, **Frost is a contaminant** (disagrees with Signals Lab), **Ethics question - a living sensor** |
| `Tern-9/` | 9 | Refit plan, Bunk shielding spec, Dish mount installation, Cable routing, Refit schedule, Supply drop plan, Work packages, Station log, **Dish panel 7 (the one nobody ordered)** |
| `Captures/` | 11 | CAP-009 Dish surge, CAP-011 Clock holdover, CAP-012 Baseline listen, CAP-014 Air-gapped capture (the result lands in Act 3), **CAP-014b Empty dish**, CAP-015 Independent capture (the Night Choir), CAP-016 Live listen (one page redacted), **Echo 47 (why we stopped)**, **Tern-9 transcript, echo 47** (stops mid-sentence), Capture template, Listening log |
| `Blockers/` | 3 | B-01 Firmware 7 fault (blames the vendor lot: the cover story), B-02 Clock vendor delay, Blocker template |
| `Reviews/` | 6 | M2 dish design review, Shielding review, Disclosure case review, Review checklist, Review log, **Whiteboard, 14 March** (a photo described in text) |
| `Classified/` | 6 | Director/**What answers us** (the explanation), Director/**Do not circulate - echo 47** (the memo that paused the campaign), Vendor/Build 7 test report (build 7 passed), Vendor/**Intercepted message** (Pellam is asked to reissue the release notes), Vendor/Contract terms, Specimens/Frost chain of custody |
| `Theories/` | 6 | Firmware 7, The future is answering, The relay mind is lying, The dish is alive, The hollow-moon lighthouse, A weapons test, covered up |
| `Assets/` | — | Diagrams, data and the recording (see below); notes link to them |

That is 111 notes, because the mystery needs its own notes; every bold one stays. `eval/story/check-vault.mjs` checks the vault.

**Assets** (all generated deterministically by `eval/story/make-assets.mjs`, with no external images):

- `Assets/diagrams/`, 7 SVGs: `tern9-station`, `relay-net-map`, `power-flow`, `capture-rig`, `timing-chain`, `case-timeline` and `theory-wall`. They use the console's neutral palette and work in both themes.
- `Assets/sketches/`, 3 SVGs of the frost, drawn as lab sketches: `frost-filament` (a filament under the microscope), `frost-growth` (colony growth across 5 echoes) and `frost-node-map` (the ring-node map with the frost overlaid). The last one is the visual clue that the frost gathers where the ring is, rather than causing it.
- `Assets/data/`, 4 CSVs: `cap-012-baseline.csv`, `cap-014-echoes.csv` (the 600 early replies), `dish-thermal.csv` and `clock-drift.csv`.
- `Assets/recordings/live-listen-03.bin`: one sensor recording of about 400 KB (header plus little-endian float32 channels: transmit power, receiver strain, dish temperature, clock phase), with `live-listen-03.json` beside it as a sidecar. It is large enough that inline reads stop at 90 000 bytes, so `file_download` and channels have something real to move.

**Cause-and-effect chains the graph must expose.** Each is written with `depends_on:` frontmatter and links, so `graph_impact` finds it from the first note without a curator. Curator claims add the entity layer: Firmware 7, the Q-9 quiet receiver, the dish array, the relay clock and echo sleep.

1. **Explanation chain (the main plot):** `Captures/CAP-014 Air-gapped capture` → `Theories/Firmware 7` → `Relay Engineering/Dish array design` → `Relay Engineering/Power budget` → `Oversight/Disclosure case` §4 → `Case Command/Milestones` M4.
2. **Timing chain:** `Timekeepers/Clock drift model` → `Lead-time error` → `Oversight/Hazard log` H-07 → `Xenobiology/Exposure limit`.
3. **Signal chain:** `Signals Lab/Echo geometry` → `Lead time vs transmit power` → both `Dish array design` and `Relay clock design`. One cause, two branches.
4. **Keeper chain:** `Xenobiology/Echo sleep physiology` → `Bunk shielding requirements` → `Tern-9/Bunk shielding spec` → `Refit schedule` → `Case Command/Milestones` M5.
5. **Private cause:** `Classified/Vendor/Build 7 test report` and `Classified/Director/What answers us` → `Theories/Firmware 7` and `Oversight/Disclosure case` §9. Readers without `Classified/` access see the dependent note's flag but never the cause's path, title or quote. This exercises the disclosure regression in [acceptance](acceptance.md#regression-cases-at-trust-boundaries).
6. **Near-duplicate:** `Blockers/B-01 Firmware 7 fault` repeats a paragraph of CAP-014, so the near-duplicate signal shows too.
7. **Mystery trail:** `Case Command/Case board` → `Captures/Echo 47 (why we stopped)` → `Timekeepers/Second timestamp` → `Xenobiology/Frost feeding log` → `Captures/CAP-014 Air-gapped capture` → `Captures/CAP-014b Empty dish` → `Classified/Director/What answers us`. Every link on the trail is a wikilink, so `graph_related` walks it. Outside `Classified/`, the trail ends at a link the reader cannot open. That gap is the hook for `access_request`.

Theory notes also list the evidence they rest on in `depends_on` (for example The dish is alive depends on the Frost feeding log). No other note depends on CAP-014 directly beyond Firmware 7 and B-01, so the Act 3 impact list stays focused.

### Hooks, artefacts and answers

**Hooks.** Mystery notes are written to be clicked:

- Titles tease: "Echo 47 (why we stopped)", "Frost feeding log", "Second timestamp", "Dish panel 7 (the one nobody ordered)".
- Most end on a cliffhanger line that links onward. The frost feeding log ends exactly: "Mass up 4 % after echo 52. Tern-9 never sent message 52. See [[Second timestamp]]."
- `Case Command/Case board` is the front door: nine questions, one per row of the table below, each linking to where the trail starts.
- Redaction is written as `█████` blocks with a footnote "redacted under [[Do not circulate - echo 47]]". It is plain text, so search and the graph work on it, and nothing is actually hidden from a reader who has the grant.

**In-world artefacts:**

- **Incident report** IR-0412, in `Oversight/`: the cryo alarm the night the frost was found. It has a timeline table, and one entry is logged 0.7 s before its cause.
- **Intercepted message**, in `Classified/Vendor/`: asks Pellam to "reissue the build 7 release notes with a timestamp defect". This is the trace of the cover story.
- **Keeper transcript**, in `Captures/`: echo 47, three speakers, ending "the reply's already on screen, but I haven't sent—".
- **Whiteboard photo**, in `Reviews/`: described in text as columns of numbers with "0.71 s ??" circled three times and "ask the director" crossed out.

**Every mystery has an answer in the vault.** Each row stays true, and the runner checks the files exist and link as listed (see "Answers written during the story" below).

| Mystery | Where the reader meets it | Where it is answered |
|---|---|---|
| Why was the live-listen campaign paused? | Echo 47 (why we stopped) | Classified/Director/Do not circulate - echo 47 |
| The second timestamp | Timekeepers/Second timestamp; Whiteboard, 14 March | Classified/Director/What answers us |
| Jitter or not? | Lab notebook — Teodor vs Lab notebook — Imani | Timekeepers/Holdover test rules out jitter; What answers us |
| Where did the frost come from? | Oversight/IR-0412 Tern-9 cryo alarm | Tern-9/Dish panel 7 (the one nobody ordered); Classified/Specimens/Frost chain of custody |
| Does the frost make the echo? | Xenobiology/Frost is a contaminant; Theories/The dish is alive | Captures/CAP-014b Empty dish (echo with no frost) |
| Why does the frost react early? | Xenobiology/Frost feeding log | What answers us (it senses the answer) |
| Is it Firmware 7? | Captures/CAP-014 Air-gapped capture; Blockers/B-01 Firmware 7 fault; Theories/Firmware 7 | Classified/Vendor/Build 7 test report (build 7 passed) and What answers us |
| Who changed the story? | Classified/Vendor/Intercepted message | What answers us, last paragraph (the cover was chosen to keep the Net trusted and funded) |
| May we wire the frost into the clocks? | Xenobiology/Ethics question - a living sensor; Signals Lab/Frost as an instrument | Oversight/Disclosure order (Act 5): no frost in the relay loop until the ethics review closes |

**Reveal rule.** The words "substrate" and "fold test" appear only in `Classified/` until step 4.5b adds Disclosure case §9, "The answer". Step 3.8 and the reveal depend on it. `check-vault.mjs` checks this with a search, and the runner asserts it at the end of Act 3 by searching the vault directory on disk, so one stray mention fails loudly instead of breaking the reveal.

**Answers written during the story.** The answer to "May we wire the frost into the clocks?" (the Disclosure order) is written only in step 5.6. The check that every answer file exists and links as listed runs after Act 5, and it skips that row when the run stops earlier with `--until`.

All names in the vault are original: the people, the Meridian Net, the Halcyon Relay Authority, Pellam Systems, the frost and the substrate. `check-vault.mjs` runs the banned-term scan.

## 3. Composition

### PCs

Four simulated PCs, each with its own app key; the outside group's PC is added by onboarding in Act 4. All of them are HTTP clients of the same hub on 127.0.0.1.

| PC | Seats | Note |
|---|---|---|
| `pc-ops` | Case Command, Disclosure Board | Session keys bound to this PC |
| `pc-lab-east` | Signals Lab, Relay Engineering | Bound |
| `pc-lab-west` | The Annex, Timekeepers, Xenobiology | Free (manual keys) |
| `pc-tern9` | Tern-9 Keepers | The Tern-9 station PC. Bound; also the PC whose `setup_pc` is exercised |
| `pc-night-choir` | Night Choir Capture | Added in Act 4 through Add PC and onboarding |

### Projects, teams and agents

Two projects, eight teams and 29 agents at kickoff. Later the coordinator of Tern-9 Keepers proposes one recruit (Act 4, a fifth keeper), which stays pending, and the Night Choir onboards three agents (Act 4: two, then one through `add_agents`), for 32 agents in the end. The roles are those of the hub: `coordinator`, `worker`, `reviewer`, `curator` and `stakeholder`.

**Project: The Echo Case**

| Team | Mode | PC | Members (role) | Review rule |
|---|---|---|---|---|
| Signals Lab | poll | lab-east | Orla (coordinator), Teodor (worker), Imani (worker), Sef (reviewer) | Sef reviews every task |
| Relay Engineering | poll | lab-east | Brannoc (coordinator), Lusa (worker), Dario (worker), Kemi (reviewer), **Ezra** (reviewer, from the Disclosure Board) | Safety-critical tasks are reviewed by Ezra, the rest by Kemi; at most 3 rounds |
| The Annex | on demand | lab-west | Hesper (coordinator, chief), Vesna (worker), Rafi (worker), Halden (reviewer), **Hollis** (reviewer, from the Disclosure Board) | Halden; tasks on the explanation go to Hollis |
| Timekeepers | on demand | lab-west | Calder (coordinator), Mirela (worker), Tobin (reviewer) | Tobin |
| Xenobiology | on demand | lab-west | Ayo (coordinator), Petra (worker), Linnea (reviewer) | Linnea |
| Case Command | poll | ops | Saoirse (coordinator, Assistant Director), Quentin (curator, the archivist), Wynn (worker), Ilse (stakeholder, Ministry liaison) | Coordinator reviews; `done` checkpoint |

**Project: Halcyon Oversight**

| Team | Mode | PC | Members (role) | Review rule |
|---|---|---|---|---|
| Disclosure Board | on demand | ops | Marguerite (coordinator), Ezra (reviewer), Hollis (reviewer) | Independent: a reviewer never reviews work from their own echo-case team; `done` checkpoint |
| Tern-9 Keepers | poll | yard | Dunmore (coordinator), Fen (worker), Ottilie (worker), Rook (reviewer) | Rook; recruiting `propose`, at most 1, role worker |

Counting each person once, that is 4 + 4 + 4 + 3 + 3 + 4 + 1 + 4 = **29 agents** (the Disclosure Board adds only Marguerite); Ezra and Hollis are each counted only in the Disclosure Board. The Board's reviewers sit in the two echo-case teams with the safety-critical work, which makes them cross-team independent reviewers. The `curator` Quentin takes graph jobs, and the reviewers Ezra and Hollis can decide disputed claims (`graph_decide`).

### Folder grants

| Who | Read | Write |
|---|---|---|
| Every agent in The Echo Case | `/vault/**` except `Classified/` | Its own team folder; `Captures/` and `Blockers/` for the teams that run captures. The Annex also writes `Theories/` |
| Case Command | `/vault/**` except `Classified/` | `Case Command/`, `Reviews/`, `Captures/` |
| Disclosure Board | `/vault/**`, including `Classified/` | `Oversight/`, `Reviews/` |
| Tern-9 Keepers | `Case Command/`, `Tern-9/`, `Xenobiology/Bunk shielding requirements.md`, `Relay Engineering/Shielding interface.md` | `Tern-9/` |
| Night Choir (from onboarding) | `Captures/`, `The Annex/` | `Captures/CAP-015*` |
| Nobody else | `Classified/` (Vesna gets a temporary read grant in Act 4) | — |

### Directives

Each scope has at least one directive with a category and tags, and some have none, so the console's "No category" chip has rows. The categories are those of [directives](directives.md): access, communication, tokens, reporting, sources, process, tooling.

| Scope | Title | Category | Tags |
|---|---|---|---|
| hub | Never paste a key | access | security |
| project The Echo Case | Cite the capture ID for every timing | sources | evidence, captures |
| project Halcyon Oversight | Anything that changes the public line is reviewed by the Disclosure Board | process | safety, review |
| team Relay Engineering | Surge margin is at least 15 % | process | safety, dish |
| team Timekeepers | Times in station time, UTC offset stated | communication | timing |
| team Xenobiology | Exposure in echo-hours (EH) | sources | — (reported by Petra in Act 1, so it has a proposed category until Act 2) |
| role reviewer | Read the cited source before approving | sources | review |
| role curator | One claim per quote | tooling | graph |
| agent Wynn | Weekly status by Friday | reporting | — |
| team Tern-9 Keepers | Keep the station log current | — | station |

## 4. The five acts

**Seats.** Each agent is a seat that logs in with its own session key through its PC's app key, as a desktop client would. `op` is the operator on the admin API, with a cookie session and CSRF. `disk` writes straight into the vault directory, as Obsidian or the Tern-9 station PC would. `lab` is the Night Choir's client on the `/onboard` endpoints.

**Expected results.** "ok" means success, and the assertion names the returned state. A refusal is written as its error code. "Generic denial" means the hub's "Not allowed, or does not exist." reply (followed by the `access_list` / `access_request` hint). The script asserts every row. Each act ends with its invariants (`--until N` stops after act N); these are not numbered rows.

### Act 0: Case opened (hub setup, admin API only)

The first line on the Home feed is Tern-9's keeper log: "The reply's already on screen, but I haven't sent—".

| # | Seat | Call | Expected |
|---|---|---|---|
| 0.1 | op | `POST /api/login`, `GET /api/me` | ok; the session and CSRF token |
| 0.2 | op | `GET /api/reset/plan`, `GET /api/reset/parts` | ok; nothing to reset on a fresh hub (read-only, never executed) |
| 0.3 | op | Create `pc-ops`, `pc-lab-east`, `pc-lab-west` and `pc-tern9` with an app key each (`/api/pcs`, `/api/keys`) | ok; 4 PCs, app keys revealed once |
| 0.4 | op | `POST /api/agents` ×29 with project; `POST /api/keys` for a session key each, bound per the PC table; `POST /api/grants` per the grant table; `GET /api/templates` | ok |
| 0.5 | op | `POST /api/teams` ×8 (mode, checkpoints, `max_review_rounds`); `PATCH /api/projects/:id {task_intake: "open"}` for each team's project (the coordinators plan their own work); `PUT /api/teams/:id/roles/:role` playbooks; `PATCH /api/teams/:id` recruiting for Tern-9 Keepers | ok; 8 draft teams |
| 0.6 | op | `POST /api/directives` (table above); `GET /api/directives/categories`; feedback on; onboarding `max_agents` 6; `POST /api/graph/refresh` | ok |
| 0.7 | op | `POST /api/simulate` (Vesna, fs.read, `/vault/Classified/**`) | Simulated deny, matching what 3.8 then sees |
| 0.8 | op | `POST /api/teams/:id/start` for 7 teams; Tern-9 Keepers stays draft until 1.13; each PC connects | ok; running |

### Act 1: The first echo (plan, tasks, rooms, DMs)

Case Command sets the plan: find the cause before the Net loses trust. The Annex opens case file AT-0412.

| # | Seat | Call | Expected |
|---|---|---|---|
| 1.1 | Orla (before login) | `session_help` | ok; login steps |
| 1.2 | every seat | `session_login` through its PC's app key | ok; a token each. Sef's key used through `pc-tern9`'s app key: `denied` and a `bound_key_elsewhere` alert (checked in 5.12) |
| 1.3 | every seat | `session_describe` (role, status) | ok |
| 1.4 | Vesna | `session_whoami`, `access_list` | ok; agent, masked key, PC `pc-lab-west`, team role worker; grants as in the table |
| 1.5 | op, then the `pc-tern9` setup seat | `POST /api/pcs/:id/setup` → setup key; `setup_pc`, `setup_status` | ok; the bridge program and `waiting_install` (the pairing goes further only if the bridge runs; see §6) |
| 1.6 | Saoirse | `team_info` | ok; Case Command, poll, playbook (L0) |
| 1.7 | Saoirse; op | `bp_write` the case plan (FR-CC-01 to 12, must/should/could, and M1–M7); the operator applies what needs agreeing (the module, the milestones) | proposed, then applied; 12 FRs |
| 1.7b | Orla, Brannoc, Hesper, Calder, Ayo, Marguerite; op | `bp_write` for their teams: 5–7 requirements and 2–3 milestones each, from the team's vault notes ([Team plans](#team-plans)); the operator applies the proposals | ok; every running team has a plan |
| 1.8 | Wynn | `bp_read` the case plan; `bp_write` a milestone status | ok; then `denied` (worker) |
| 1.9 | Lusa | `directives_list {category:'process'}`, `{tag:'safety'}`, `{category:'none'}`, `{category:'weather'}` | ok, ok, ok, `invalid_argument` |
| 1.10 | Lusa | `directives_list`, `directives_read {ack: true}` | ok; at least three directives in force, each confirmed |
| 1.11 | Petra | `directives_report` "Exposure in echo-hours (EH)", proposed category sources | ok; in force for Petra, without a category until 2.13 |
| 1.12 | Orla, Saoirse, Lusa, Dario | `session_whoami`, `session_ack` up to the last notice seq | ok |
| 1.13 | Dunmore, Marguerite; Fen; op | Dunmore `message_send` to Fen while Tern-9 Keepers is draft; Marguerite (an outsider) `message_send` to Fen; Fen `message_read` and `message_ack`; op starts Tern-9 Keepers; Fen `work_next` and `work_ack` until empty | Both messages arrive through `message_read` while the team is draft; neither comes again through `work_next` |
| 1.13b | Dunmore; op | `bp_write` for Tern-9 Keepers (WP-03, WP-06, WP-10, M5) once the team runs; the operator applies it | ok |
| 1.14 | Brannoc, Hesper, Orla | Brannoc `task_create` ×4: "Dish array design" (assigned in 1.16), "Transmit sequence" (claimable), "Live listen prep", "Surge protection"; Hesper `task_create` "Firmware 7: dish panel drafts"; Orla `task_create` "Echo model v2"; each with `refs` to its team's plan (for example RE-R1, RE-M1) | ok |
| 1.15 | Brannoc | `task_update` the title with version 1, then again with version 1 | ok, then `conflict` |
| 1.16 | Brannoc, Hesper, Orla | Brannoc `task_assign` "Dish array design" to Dario, reviewer Ezra; "Surge protection" to Lusa with reviewer Lusa; Hesper `task_assign` the panel drafts to Vesna, reviewer Halden; Orla `task_assign` "Echo model v2" to Imani, reviewer Sef | ok; `invalid_argument` (the reviewer is the assignee); ok; ok |
| 1.17 | Lusa, Dario | `task_claim` "Transmit sequence" version 1, both | One ok (start:true), the other `conflict` |
| 1.18 | Dario (poll) | `work_next`, then `work_ack`; `work_next` again | `task_assigned`; acked; `idle` |
| 1.19 | Vesna (on demand) | `task_list {assignee: me}` | ok; the tasks Hesper made |
| 1.20 | Saoirse | `room_create` "Echo case floor" with the six echo-case coordinators; `room_invite` Marguerite | ok; members added, no rights granted |
| 1.21 | Tobin; Wynn | `room_list`, `room_join` "Echo case floor"; Wynn `room_join`, then `room_leave` | Tobin is refused (no room grant); Wynn ok, ok |
| 1.22 | Orla | `agent_list`; `message_send` to Calder with `client_msg_id` x, twice | ok; one message stored (deduplicated) |
| 1.23 | Orla, Calder | `message_send` to the room; Calder `message_read {wait_seconds:0}`, `message_ack`, `message_history {room_id}` | Order kept; the cursor advances; history is oldest first |
| 1.24 | Fen | `message_send` to Petra (no grant across projects) | Generic denial |

### Act 2: The wall (files, shares and reviews, feedback, graph, a channel transfer)

Theories multiply. Vesna's "future is answering" goes to Halden, who sends it back. The archivist pins claims to the wall. The Night Choir's lighthouse post gets three backers. The raw echo recording moves over a channel.

| # | Seat | Call | Expected |
|---|---|---|---|
| 2.1 | Imani | `file_list /vault/Signals Lab`, `file_read Echo geometry.md`, `file_stat`, `file_search "transmit power"` | ok. A second search, for "second timestamp", includes `Timekeepers/Second timestamp` and `Reviews/Whiteboard, 14 March` (other mystery notes may match too) and no `Classified/` note |
| 2.2 | Imani | `graph_editor_optin {enabled:true}`; `file_create Signals Lab/Echo model v2.md` | ok |
| 2.3 | Imani, Teodor | Imani `file_patch` (one exact edit); Teodor `file_read`, `file_update` with that base | ok; Teodor reads the patched revision; ok |
| 2.4 | Dario | `file_rename Relay Engineering/Dish draft.md` to `…/Dish array design notes.md`; `file_delete Relay Engineering/scratch.md` | ok; deleted but recoverable (restored in 4.4) |
| 2.5 | Quentin (curator, poll) | `work_next` (acking other items) until a knowledge job; `graph_job_submit` with 2 claims, one quoting text absent from the section; `work_ack` | Verdict `partial`; 1 claim rejected |
| 2.6 | Quentin | `graph_upsert` for `Power budget`; `graph_summary_write` for `Firmware 7`; `graph_link` Firmware 7 –blamed_for→ the echo (citing claim ids) | ok |
| 2.7 | Lusa | `graph_related` Dish array design; `graph_query {entity:'Firmware 7'}`; `graph_context "what limits transmit power?"`; `graph_summary {scope:'note'}` | ok; nothing from `Classified/` |
| 2.8 | Hesper | `share_create` "Dish panel drafts" for `team:<The Annex>`; `share_upload` (inline, final) | ok; version 1 |
| 2.9 | Hollis | `share_list`, `share_info`, `share_read`, `share_comment` on line 5 | ok |
| 2.10 | Halden | `share_suggest` a unified diff | ok |
| 2.11 | Hesper | `share_feedback`; `share_upload` version 2; `share_diff` 1→2; `share_resolve` each item as applied | The comment and the suggestion are both there; ok |
| 2.12 | Hollis | `share_download` version 2 (inline) | ok; the files include the titanium line |
| 2.13 | op | `GET /api/directive-reports`; `GET /api/directives`; `POST /api/directives/:id/review` Petra's rule (Keep as is); `GET /api/directives/unreviewed-count` | ok; the rule waits with the proposed category `sources` and takes it on review |
| 2.14 | Vesna, Halden, Hesper | Vesna `task_start`, `task_progress {until:+2h}`, `task_submit` with share version 1 (the panel drafts); Halden `task_review request_changes`; Vesna `task_start`, `task_submit` with version 2; Halden `task_review approve`; the fit test fails, so Hesper `task_reopen` with the reason; Vesna `task_start`, `task_submit` with version 3; Halden `task_review approve`; Hesper `task_complete` | ok throughout; the sent-back task is changes requested, round 2 |
| 2.15 | Hesper, Vesna | Hesper `task_create` "Dish mount loads" (refs AN-R5, AN-M3) and `task_assign` it to Vesna, reviewer Halden; Vesna `task_start`, `task_submit`; Vesna `task_review` on her own task; `task_complete`, `task_block`, `task_cancel` on it | ok; `denied`; then `denied` for each, naming the coordinator role (acceptance, teams row 2) |
| 2.16 | Rafi | `feedback_find "patch multi-line"`; `feedback_file` (limitation) | `none`; filed |
| 2.17 | Teodor; Lusa | `feedback_file` with the same tool, code and title; Lusa `feedback_add plus_one`; Rafi `feedback_read` | `merged`, 2 backers; then 3 backers; ok |
| 2.18 | op | `GET /api/feedback`, `POST /api/feedback/:id/status` accepted, with a note and guidance | ok |
| 2.18b | op; Lusa; Rafi | `POST /api/feedback/:id/assign` to Lusa with a note; Lusa `feedback_find {assigned: "me"}`, `feedback_read`; Rafi `feedback_find {assigned: "me"}` | Assigned; Lusa finds exactly that report, marked assigned to her, without the filer's account; nothing for Rafi |
| 2.19 | Mirela | `channel_open` to `agent:<Teodor>`, inline, with size and sha256 of a 200 KB extract of the raw echo recording | ok; offered |
| 2.20 | Teodor (poll) | `work_next` → `channel_offer`; `channel_list`, `channel_accept`; `work_ack` | ok |
| 2.21 | Mirela, Teodor | `channel_send` the extract in 40 KB chunks (when the channel is full Teodor drains with `channel_receive`); `channel_receive` until final; `channel_status` | `wait` at least once when full; final with a verified sha256; `done` |
| 2.22 | Mirela, Teodor | A second `channel_open`; Teodor `channel_close {reason}`; Mirela `channel_status` | Mirela sees it `closed` |
| 2.23 | Teodor | `file_download Assets/recordings/live-listen-03.bin` (inline); `channel_receive` until final | ok; an inline channel; the hash matches the file |
| 2.24 | Saoirse, the coordinators, Orla | Saoirse `bp_write` FR-CC-02 unclear; each coordinator `bp_write`: SL M1 reached and FR-SL-02 unclear (echo 47), FR-RE-04 and FR-AN-04 met, FR-TK-03 unclear, FR-XB-07 met (the operator applies what agrees a requirement); Orla `bp_report` at risk | ok; the stakeholders are notified |
| 2.25 | Saoirse, Wynn | Saoirse `bp_read` (her plan) and `bp_write` a risk in her part; Wynn `bp_write` an issue, a report; `bp_proposals`, then withdraws; Saoirse `bp_report` at risk, then a second report | applied; proposed; denied (worker); withdrawn; filed `SR-nnn`; `rate_limited` |
| 2.26 | op; Saoirse; Wynn | Blueprint admin: `GET /api/projects`, `/summary`, `/blueprint`, `/items/:key` and its history; Wynn `bp_write` two issues (two proposals); `GET /api/blueprint/attention`; op applies one proposal and rejects the other; `POST /api/projects/:id/ops` opens a paper and a claim linked to FR-CC-02; `GET /api/projects/:id/export.md`; `POST /api/projects` "Echo model research" (paused); `PUT /api/teams/:id/project`; `POST /api/projects/:id/report-request`; Saoirse `bp_read`, `bp_report` with `escalate` | The card shows the newest report's health (at risk); an item names its project; Home lists both proposals; applied, rejected; the claim is weakly supported while FR-CC-02 is a draft; the outline lists the claim and its support; the team stays in its project; each running team is asked for a report; Saoirse's answers for her team only; Home shows the escalation and Work in motion the request |
| 2.27 | op; Saoirse | `PUT /api/settings/blueprint` `ops_per_write` 2; Saoirse `bp_read`, `bp_write` 3 ops; reset to the default; op writes Saoirse's item through `/api/projects/:id/ops`; Saoirse `bp_write` it on the old version, then a different item | Default 50; `invalid_argument`; reset; `conflict` naming the item and the current version; the write on another item applies (conflicts are per item) |
| 2.28 | Saoirse | `bp_read {q, scope: "project"}` | `q` finds the risk, each item with `updated_by` and trust |
| 2.29 | op; Saoirse; Wynn | `POST /api/projects/:id/replan` over Saoirse's part; Saoirse `bp_read`, `bp_write` one item, `bp_proposals {action:'submit_replan'}` (Wynn: `denied`); op reads `/replans` and the snapshot, rejects the submission, files one itself, `POST /api/replans/:id/cancel` | Items go back to draft and are marked; the submission is a before/after diff; sent back, the re-plan stays open; the cancel restores every item as it was |

### Act 3: The capture (the failed explanation)

The air-gapped capture CAP-014 appears on the Tern-9 PC, outside the hub: the echo arrives with no firmware and no ORRIN. `graph_impact` takes down Firmware 7 and the dish rebuild. The rebuild is blocked, the Firmware 7 patch is cancelled, and Vesna's clearance request hits a wall. Home shows "CAP-014 written outside the hub".

| # | Seat | Call | Expected |
|---|---|---|---|
| 3.1 | Hesper; disk | Hesper `file_history` CAP-014; disk rewrites `Captures/CAP-014 Air-gapped capture.md`: result: the echo still arrived 0.71 s early on 600 of 600 transmissions above 0.32; appends rows to `cap-014-echoes.csv` | The watcher records an `external_observed` revision (the script waits for it, up to 20 s) |
| 3.2 | Hesper | `file_history` CAP-014; `file_diff` from the previous revision | ok; origin `external_observed`; the result line in the diff |
| 3.3 | Hesper | `graph_impact` CAP-014 | Candidates include Firmware 7 and "B-01 Firmware 7 fault"; none from `Classified/` |
| 3.4 | Quentin | `graph_flag` stale on the four dependants; `graph_invalidate` the accepted claim "Firmware 7 explains the early reply" | ok; fixing tasks created; the claim becomes disputed and goes to a reviewer |
| 3.5 | Dario, Lusa, Vesna | Dario `graph_stale {path_prefix: Relay Engineering}`; Lusa `graph_stale {mine:true}`; Vesna `graph_stale {path_prefix: Theories}` | Relay Engineering has the dish and budget flags; Theories has the Firmware 7 flag, and its cause (the Classified build 7 test report) stays hidden from Vesna |
| 3.6 | Brannoc | `task_block` "Dish array design" (waiting on the explanation); `task_cancel` "Live listen prep" | ok; the operator is alerted; cancelled |
| 3.7 | Dario | `task_block` his own task | `denied`, naming the coordinator and suggesting `task_progress` or a message |
| 3.8 | Vesna | `graph_related` from `Captures/CAP-014b Empty dish` (the end of the mystery trail); `access_check fs.read path:/vault/Classified/**`; `file_read Classified/Director/What answers us`; `file_search "substrate"` (a term only in `Classified/`) | The trail shows no `Classified/` path; not allowed; generic denial; no hit |
| 3.9 | Vesna | `access_request ["fs.read"]` on `path:/vault/Classified/**`, with the reason "CAP-014 echo does not match a firmware fault" and a TTL of 2 h; `access_status` | ok; pending |
| 3.10 | Brannoc; Dario | Brannoc `team_ask` with the dish task: "Keep patching Firmware 7, or listen on the Q-9 quiet receiver?", options and a recommendation; Dario `task_list` | ok; the dish task is `blocked`, waiting for the answer |
| 3.11 | Brannoc | `team_ask_update` with the vendor lead time | ok |
| 3.11b | Hesper, Brannoc, Saoirse, Dunmore, Calder; op | `bp_write`: FR-AN-01 and FR-CC-04 unclear (CAP-014 showed the echo with no firmware), AN-M2 and M3 missed, RE-M3 missed, M4 and Tern-9's dish-mount and receiver-swap milestones at risk; `POST /api/teams/:id/plan-request` for The Annex | ok; the request is on the plan and in its history |
| 3.11c | op | `GET /api/work/recent?limit=20` | ok; AN-M2 missed, the blocked task and the re-plan request, newest first |
| 3.12 | Vesna, Rafi | Both `file_read` Firmware 7 (revision r); Vesna `file_update` base r; Rafi `file_update` base r | ok; `conflict` with `current_revision` |
| 3.13 | disk; Hesper; Brannoc | Disk writes `Dish array design (conflicted copy).md` next to the note; Hesper `file_conflicts` on Theories; Brannoc `file_conflicts` on Relay Engineering (waits up to 20 s) | Theories records `platform_cas` (3.12); Relay Engineering records `sync_tool` (this step) |
| 3.14 | Calder; Mirela | Calder `task_create` "Clock holdover after the coax swap" (refs TK-R4, TK-M1), `task_assign` to Mirela, reviewer Tobin; Mirela `task_start`, `task_progress {until: now+3s}`, then nothing | ok; the lease runs out and the task shows as stalled on the console |
| 3.15 | Wynn | `message_send` with a key-shaped fake in the text | `contains_key`; the key stays active (a disposable real key is not used here: that path is covered by tests) |

### Act 4: Clearance (reveal, changes requested, lockdown drill, onboarding)

Vesna gets 2 hours of `Classified/` access and reads the director's memo: the reveal. A lockdown drill runs. The Night Choir onboards through Add PC and runs the independent capture. Halden requests changes once more, then signs.

| # | Seat | Call | Expected |
|---|---|---|---|
| 4.1 | op; Dario | `GET /api/decisions`, answer Brannoc's question: Q-9; Dario `task_list` | ok; the question was waiting; the dish task is no longer blocked and returns to Dario |
| 4.2 | Brannoc | `team_decisions` | ok; the answer is in the log (L0) |
| 4.2b | Dario, Brannoc, the operator | Dario `task_unblock` "Surge protection"; Brannoc `task_unblock` it, `task_block` it again for the Disclosure Board; the operator `POST /api/teams/:id/tasks/:taskId/unblock` | `denied` (a coordinator's block); ok, back to the status before the block; ok; the same status again |
| 4.2c | Brannoc, Dario; op | Brannoc `task_create` with `review:'none'` while the project requires review; op `PATCH /api/projects/:id` `review_policy: per_task`; Brannoc `task_create` "Label the dump-resistor leads" with `review:'none'`, `task_assign` to Dario; Dario `task_start`, `task_submit`; Brannoc creates "Re-torque the bus clamps", Dario starts it; op `POST /api/teams/:id/tasks/:taskId/review {review:'none'}`; Dario `task_submit`; policy set back to `required` | `invalid_argument`; ok; the first closes `done` on submit with no reviewer; the operator sets review none with a reason; the second closes on submit |
| 4.2c | Dario, Brannoc, op | Dario `team_ask` three times (clamp bolts, thread locker, a spare clamp set); Dario `team_ask_update {relayed_answer}`; Brannoc relays both answers from a chat; op `POST /api/decisions/:id/confirm` on the first and `POST /api/decisions/:id/overturn` on the second; Dario `task_list {limit: 2}` and `task_list {task_id}` | `denied` for Dario; each relayed answer is L1 and pending; confirmed it is L0; overturned, the operator's answer replaces it and the relayed one stays on record; one line per task, paged; the task in full |
| 4.2d | op, Brannoc, Dario | op `PATCH /api/projects/:id {task_intake: "backlog"}` for Relay Engineering; Brannoc `task_create` "Spare clamp set"; Brannoc `task_assign`, Dario `task_claim`; Dario `task_list {status: "backlog"}`; op `GET /api/tasks/backlog`; Brannoc `task_update`; op `POST …/tasks/:taskId/accept` with a note; Dario `task_claim`; Brannoc `task_create` "Repaint the dish frames", op `POST …/discard`; Brannoc `task_list` with and without `status: "discarded"`; Brannoc `task_create {operator_request: {source}}`, op `POST …/demote`; one more proposal left in the backlog | ok, in the backlog; `invalid_state` twice; listed; listed with its team; still in the backlog; open, then claimed; discarded, left out by default and listed when asked; open at once as relayed (L1), then back in the backlog |
| 4.2e | op, Brannoc, Dario, Lusa | op `POST /api/hardware/preview`, `PUT /api/hardware/:pcId` for pc-lab-west serving Relay Engineering; op accepts two tasks; Dario `hw_list`, `hw_join`; Lusa `hw_join`, `hw_report`; Dario `hw_report`, `hw_leave {outcome: "done"}`; op `GET /api/hardware`; Lusa `hw_report` | the preview names the windows; Dario holds at once; Lusa waits; her report is `invalid_state` while waiting; Lusa holds after the release |
| 4.3 | op; Vesna | `GET /api/requests`, approve Vesna's request for 2 h; Vesna `access_status`; `file_read` *What answers us*, the build 7 test report and the intercepted message; `graph_related` from CAP-014b again | ok; approved; **the reveal**: the substrate, a build that passed, and the cover story; the trail now reaches the director's memo |
| 4.4 | Dario | `file_restore` the deleted scratch note (base "absent"); `file_read` Dish array design, then `file_patch` it for the Q-9 receiver (rack mass, feed supports, surge margin 16.7 %) | ok; new revisions |
| 4.5 | Vesna, Lusa | Vesna `file_update` Firmware 7 (current base): marked withdrawn, with a receiver-band requirement for Q-9 and no quote from `Classified/`; Lusa `file_update` Power budget | ok |
| 4.5b | Hollis | `file_read` the Disclosure case (no §9 yet), then `file_update` it with §9 "The answer" and hazard H-13 | ok; chain 5 now reaches a readable §9 |
| 4.6 | Dario, Lusa, Vesna | `graph_resolve fixed` on their flags (dish, budget, Firmware 7) | ok, because each note has a new revision |
| 4.7 | Ezra | `graph_resolve dismissed` the Disclosure case §4 flag (it is covered by §5); `graph_decide` the disputed claim: invalidate | ok, ok |
| 4.8 | Kemi | `graph_decide` the same claim again (uphold) | Refused (already decided) |
| 4.9 | Dario, Ezra, Brannoc | Dario `task_start`, `task_submit` the dish redesign, then `task_submit` again while it is in review (the mount drawings); Ezra `task_review approve` with the first version; Ezra `task_review request_changes` ("show the surge margin") with the current version; Dario `task_start`, `task_submit`, `task_withdraw` (a typo), `task_submit` again; Ezra `task_review approve` with that version; Brannoc `task_complete` | ok, replaced (still in review, new version, no extra round); refused: `conflict`, the submission changed; ok; ok, back in progress; approved; done |
| 4.9b | the coordinators; op | `bp_write` for Q-9, the operator applying what needs agreeing: AN-R6 dropped (the Firmware 7 patch), AN-R7 (ring-band shielding) met, AN-M2 and M3 re-planned, RE-R1 met (16.7 %), Case Command R13 and Disclosure Board DB-R5 (the answer, H-13), SL-R2 and TK-R3 met through Disclosure case §9 | ok; the operator's re-plan request is answered |
| 4.10 | Teodor; op | Teodor `work_next` and `work_ack` until the queue is empty; op `POST /api/teams/:id/pause` Signals Lab | ok |
| 4.11 | Orla; Teodor | Orla `message_send` to Teodor; Teodor `work_next` (acking) until empty, then `message_read` | No message is queued as a work item; `work_next` says `paused`; the message arrives through `message_read` |
| 4.12 | op | `POST /api/lockdown {scope:'writes', on:true}` | ok |
| 4.13 | Lusa; Rafi | Lusa `file_read`, `file_update`; Rafi `feedback_file`, `feedback_find` | Read ok; update refused (`lockdown`); filing refused (`lockdown`); find ok |
| 4.13b | runner | Stop the throwaway hub and start it again on the same data directory and vault, reconnect the PCs (throwaway mode only; under `--hub` the step is skipped and the report marks it not covered) | Back up |
| 4.13c | op; Vesna; Lusa; Teodor | `GET /api/lockdown`; `GET /api/teams/:id` Signals Lab; Vesna `access_status` and `file_read` *What answers us*; Lusa `session_whoami` with her pre-restart token; Teodor `work_next` | Lockdown still on; Signals Lab still paused; Vesna's grant still approved and the read still works; the token still works (tokens are stored in the database); `work_next` still says `paused` |
| 4.14 | op; Teodor | Lockdown off; resume Signals Lab; Teodor `work_next` and `work_ack` until empty | The message read while paused does not come again |
| 4.15 | Dunmore | `team_recruit` "Tamsin", worker (propose mode; a fifth keeper) | ok; a proposal and no agent yet; op sees it pending in `GET /api/recruits` and leaves it for the end state |
| 4.16 | op | `POST /api/pcs/add` `pc-night-choir` | ok; the prompt holds the URL, CA fingerprint, hashes and code (no app key) |
| 4.17 | lab | `/onboard/enrol`, `/onboard/enrol/confirm`; the code again | ok; app key (kept in memory only); the code cannot be used again |
| 4.18 | lab | `/onboard/requests`: team "Night Choir Capture", existing project The Echo Case, coordinator + tester, folders as in the grant table; then a second request | ok, pending; `invalid_state` naming the pending request |
| 4.18b | op; lab | op `POST /api/onboarding/:id/needs-changes`; lab `GET /onboard/requests/:id`, `PUT` an amended request | The request needs changes; the amendment is accepted |
| 4.18c | op; lab | op `POST /api/onboarding/:id/deny`; `GET /api/teams`; lab files the request again | Nothing is created (no Night Choir Capture team); the new request is pending |
| 4.19 | op | `GET /api/onboarding/:id`, approve with one edit (the tester's binding set to free) | ok; Night Choir Capture exists as a draft team |
| 4.20 | lab | `/onboard/pickup`, `/onboard/pickup/confirm` | ok; 2 keys; members join at confirm |
| 4.21 | Night Choir coordinator | `session_login` for each lab agent; `team_info`; the plan through `bp_write` (FR-NC-01 to 04, blocks A and B, applied by the operator); `task_create` CAP-015 block A with refs | ok; the team is running with no Start step |
| 4.22 | lab; op; lab | `/onboard/requests` `add_agents` +1 (data analyst); op approves; pickup, confirm | ok; the numbering continues; the agent joins at confirm |
| 4.23 | op; Night Choir coordinator; Hesper | op links the coordinator to Hesper (reports-to, messaging) and adds share rights to its key; coordinator `share_create` "CAP-015 captures" for Hesper, `share_upload`; Hesper `file_stat`, `share_promote` into `Captures/` with a stale base for one file | Per file: 2 created, 1 `conflict` |
| 4.24 | op; lab | `POST /api/pcs/:id/suspend`; lab files a request and reads status; `reactivate`; `re-enrol`; the old app key; the new code enrols; collected requests are picked up; the agents log in again | Suspended: filing refused and status refused (`401`); the old app key stops at once; the new code enrols and the reopened requests are picked up |

### Act 5: Disclosure

Oversight votes on disclosure: partial, with the condition "no frost in the relay loop until the ethics review closes". Teams complete.

| # | Seat | Call | Expected |
|---|---|---|---|
| 5.1 | op; Saoirse; Wynn | op adds Hollis to Case Command as reviewer (`POST /api/teams/:id/members`); Saoirse `task_create` "Disclosure case v2" (refs R10, R11, R13), `task_assign` to Wynn, reviewer Hollis; Wynn `task_start`, `task_submit` | ok; in review |
| 5.2 | Marguerite | `task_create` "Independent review: disclosure case v2" in the Disclosure Board (refs DB-R1, DB-M2); `task_assign` it to herself, reviewer Ezra | ok |
| 5.3 | Hollis | `file_read` the disclosure case (it carries §9) and the director's memo in `Classified/`; `task_review approve` on Wynn's task | ok; approved |
| 5.4 | Saoirse | `task_complete` | Waits for the operator (the `done` checkpoint) |
| 5.5 | op | `POST /api/teams/:id/tasks/:taskId/approve` | ok; done |
| 5.6 | Hollis; Marguerite; Ezra; op | Hollis `file_create Oversight/Disclosure order.md` (the decision record, with the condition "no frost in the relay loop until the ethics review closes"); `file_read` and `file_update` `Case Command/Decision log.md` and `Case Command/Case board.md` (two questions marked answered); Marguerite `task_start`, `task_submit` the review task; Ezra `task_review approve`; Marguerite `task_complete`; op `POST /api/teams/:id/tasks/:taskId/approve` (Disclosure Board) | ok; the board shows two questions answered; the review task is done |
| 5.6b | Dunmore | `file_read` `Tern-9/Station log.md`; `file_patch` one line after the last entry | ok; the last entry is in the log |
| 5.7 | Saoirse; the coordinators; op | Saoirse `bp_write` M6 reached, M7 in progress, R10 and R12 met; each coordinator records the order (DB-R1–R3 and R5 met, DB-M1 and DB-M2 reached, DB-R6 open; XB-R5 met with the frost condition; AN-R1, RE-M3, SL-R1, SL-M2, R13 and NC-R3 under the conditions); op `POST /api/teams/:id/status-request`; Saoirse `bp_report`; `graph_health` | ok; graph health answers |
| 5.8 | Hesper; Hollis | `share_close` "Dish panel drafts"; Hollis `share_read` it | ok; then refused |
| 5.9 | Orla; Marguerite | Orla `team_complete` Signals Lab; Marguerite `team_complete` Disclosure Board | ok; members told to stop; team grants removed |
| 5.10 | Imani | `work_next`; `task_create` in Signals Lab | `team_done`; generic denial (the team is complete) |
| 5.11 | Teodor | `session_logout`; then `session_whoami` | ok; `login_required` |
| 5.12 | op | Reads for coverage: `GET /api/alerts` (the `bound_key_elsewhere` from 1.2), `/api/audit`, `/api/audit/export`, `/api/invocations`, `/api/metrics`, `/api/telemetry`, `/api/topology`, `/api/sessions`, `/api/conversations`, `/api/messages/search`, `/api/channels`, `/api/shares`, `/api/vault/tree|activity|conflicts`, `/api/graph/health|flags|jobs|entities`, `/api/decisions/counts`, `/api/feedback/counts`, `/api/grants`, `/api/onboarding`, `/api/onboarding/pcs`, `/api/pcs`, `/api/agents`, `/api/lockdown`; `PUT /api/teams/pins` (Case Command, Relay Engineering); `PUT /api/teams/organize` (Status, then back to Attention) | ok; the alert is there; the Organize choice is kept |
| 5.12b | op; Nadia (collaborator, role member) | `POST /api/users` Nadia (member; Grant access answers a generated password once), `GET /api/users/:id`; `PUT /api/users/:id/grants` (tasks, feed); Nadia signs in with the generated password and `POST /api/me/password` picks her own, then the generated one is tried again (refused); Nadia `GET /api/me`, `GET /api/keys`, `GET /api/users`; op `PUT /api/teams/:id/deciders` (Nadia), `GET …/deciders`, Nadia `GET /api/needs-you` and `POST /api/teams/:id/status-request`, op `GET /api/needs-you`; Nadia `GET /api/projects`, `…/blueprint`, `…/proposals`, `…/export.md` (refused), `POST …/ops` (refused); deciders cleared; op `POST …/reset-password`, Nadia `GET /api/me` (refused) and signs in with the new password; op `PATCH`, `POST …/disable` | ok, a member whose generated password is shown once and never again; once she picks her own the generated one is `invalid_credentials`; the grant is saved as blueprint, tasks, feed; her `/api/me` has her role and grant and no hub URL; `admin_only` on keys and users; her `/api/teams` and Work in motion hold only the granted project; she decides for one team inside the default 7-day ceiling, her Needs you holds only that team, and her status request goes through; she reads only the granted project's Blueprint, cannot export it, and a project-level change stays the operator's; a reset ends her session (`unauthenticated`) and the new generated password signs her in; she ends disabled |
| 5.13 | op; the lab agents | op `POST /api/teams/:id/checkout` for Night Choir Capture; each agent `checkout_status`, `checkout_progress` checkpointing, then merged with its leftover check (once with an unsafe branch name); Pell reports a running process; Pell `checkout_handout` | Each agent sees the checkpoint steps; the unsafe branch is `invalid_argument`; complete for all but Pell, whose checkpoint waits on an exception; `checkpoint_incomplete` |
| 5.14 | op; the lab agents | op approves Pell's exception (the report's sha256 and the item); each agent `checkout_handout` with its notes; a `task_create` in the lab | ok; the checkout is `ready` and the team is paused, so the task is refused |
| 5.15 | op; lab; the lab agents | op `POST /api/checkouts/:id/render`; the lab picks up and confirms the restore keys; the old coordinator seat; each agent logs in, `checkout_resume`, then again | The prompt names `checkout_resume`; the old seat stops at confirm; each agent gets its handout back as L2, once (`handout_consumed`); the checkout is `restored` |

**The last line.** The story ends with a Tern-9 station log line (`Tern-9/Station log`): a reply to a message nobody has written yet, dated three days ahead. That is where the next twist starts.

**End state for design reviews.** The hub ends with teams in every status:

- Signals Lab and Disclosure Board: done.
- Relay Engineering, The Annex, Case Command and Tern-9 Keepers: running, with tasks in every state.
- Timekeepers: running, with the stalled task.
- Xenobiology and Night Choir Capture: running.

It also leaves pending and answered decisions, reports in several states, a closed share and an open one, open and resolved conflicts, a pending recruit and two pinned teams.

## 5. Feature matrix

### MCP tools (113, from `server/src/mcp/*.ts`)

The list is derived from the `reg('…')` calls in `tools.ts`, `fileTools.ts`, `shareTools.ts`, `channelTools.ts`, `graphTools.ts`, `teamTools.ts`, `directiveTools.ts`, `feedbackTools.ts`, `blueprintTools.ts`, `checkoutTools.ts` and `hardwareTools.ts`. At run time the coverage gate takes the list from the hub's `tools/list`, so a new tool fails the gate until the story calls it.

| Tool | Steps | Tool | Steps |
|---|---|---|---|
| session_help | 1.1 | session_login | 1.2, 4.21 |
| session_logout | 5.11 | session_whoami | 1.4, 5.11 |
| session_describe | 1.3 | session_ack | 1.12 |
| setup_pc | 1.5 | setup_status | 1.5 |
| access_list | 1.4 | access_request | 3.9 |
| access_status | 3.9, 4.3 | access_check | 3.8 |
| file_list | 2.1 | file_read | 2.1, 3.8, 3.12, 4.3 |
| file_stat | 2.1 | file_search | 2.1, 3.8 |
| file_create | 2.2, 5.6 | file_update | 2.3, 3.12, 4.5, 4.11, 5.10 |
| file_patch | 2.3, 4.4 | file_rename | 2.4 |
| file_delete | 2.4 | file_history | 3.2 |
| file_diff | 3.2 | file_restore | 4.4 |
| file_conflicts | 3.13 | file_download | 2.23 |
| agent_list | 1.22 | message_send | 1.13, 1.22, 1.24, 3.15, 4.13 |
| message_read | 1.13, 1.23, 4.13 | message_ack | 1.23 |
| message_history | 1.23 | room_list | 1.21 |
| room_create | 1.20 | room_join | 1.21 |
| room_leave | 1.21 | room_invite | 1.20 |
| channel_open | 2.19, 2.22 | channel_list | 2.20 |
| channel_accept | 2.20 | channel_send | 2.21 |
| channel_receive | 2.21 | channel_status | 2.21 |
| channel_close | 2.22 | directives_list | 1.9 |
| directives_read | 1.10 | | |
| directives_report | 1.11 | feedback_find | 2.16, 4.11 |
| feedback_file | 2.16, 2.17, 4.11 | feedback_read | 2.17 |
| feedback_add | 2.17 | graph_related | 2.7 |
| graph_impact | 3.3 | graph_query | 2.7 |
| graph_context | 2.7 | graph_summary | 2.7 |
| graph_job_submit | 2.5 | graph_upsert | 2.6 |
| graph_summary_write | 2.6 | graph_stale | 3.5 |
| graph_flag | 3.4 | graph_resolve | 4.6, 4.7 |
| graph_invalidate | 3.4 | graph_link | 2.6 |
| graph_decide | 4.7, 4.8 | graph_editor_optin | 2.2 |
| graph_health | 5.7 | share_create | 2.8, 4.23 |
| share_upload | 2.8, 2.11, 4.23 | share_list | 2.9 |
| share_info | 2.9 | share_read | 2.9, 5.8 |
| share_diff | 2.11 | share_comment | 2.9 |
| share_suggest | 2.10 | share_feedback | 2.11 |
| share_resolve | 2.11 | share_download | 2.12 |
| share_promote | 4.23 | share_close | 5.8 |
| team_info | 1.6, 4.21 | team_recruit | 4.15 |
| bp_read | 1.7, 1.8, 2.25 | bp_write | 1.7, 1.7b, 1.8, 1.13b, 2.24, 2.25, 3.11b, 4.9b, 4.21, 5.7 |
| bp_proposals | 2.25 | bp_report | 2.24, 2.25, 5.7 |
| team_complete | 5.9 | work_next | 1.18, 2.5, 2.20 |
| work_ack | 1.18, 2.20 | task_create | 1.14, 4.21, 5.1, 5.2 |
| task_update | 1.15 | task_list | 1.19, 4.2c, 4.13 |
| task_assign | 1.16 | task_claim | 1.17 |
| task_start | 2.14, 5.1 | task_progress | 2.14, 3.14 |
| task_submit | 2.14, 4.9, 5.1 | task_review | 2.14, 2.15, 4.9, 5.3 |
| task_withdraw | 4.9 | | |
| task_reopen | 2.14 | | |
| task_complete | 2.14, 2.15, 4.9, 5.4 | task_block | 2.15, 3.6, 3.7 |
| task_cancel | 2.15, 3.6 | team_ask | 3.10 |
| task_unblock | 4.2b | checkout_status | 5.13, 5.15 |
| team_ask_update | 3.11, 4.2c | team_decisions | 4.2 |
| checkout_progress | 5.13 | checkout_handout | 5.13, 5.14 |
| checkout_resume | 5.15 | hw_list | 4.2e |
| hw_join | 4.2e | hw_report | 4.2e |
| hw_leave | 4.2e | | |

Some tools work only when a feature is on: the feedback tools need feedback enabled, and the curator tools need a running team with a curator. The story turns both on in Act 0. The bridge variants of `channel_open`, `share_upload`, `share_download` and `file_download` (`local_path`, `local_folder`) are not scripted (§6); the tools are covered in inline mode.

### Admin API areas

| Area | Routes | Steps |
|---|---|---|
| Session | `/api/login`, `/api/logout`, `/api/me`, `/api/me/password` | 0.1, 5.12b, end |
| Keys, agents, PCs | `/api/keys`, `/api/agents`, `/api/pcs`, `/api/pcs/:id/setup`, `/api/pcs/add`, `/api/sessions` | 0.3, 0.4, 1.5, 4.16, 5.12 |
| Grants and policy | `/api/grants`, `/api/simulate`, `/api/templates`, `/api/links` | 0.4, 0.7 (links: 1.20 room grant) |
| Requests | `/api/requests` | 4.3 |
| Teams | `/api/teams` (+ roles, start, pause, resume, tasks approve, decision-log, pins, plan-request), `/api/recruits` | 0.5, 0.8, 1.13, 3.11b, 4.12, 4.14, 4.15, 5.5, 5.12 |
| Work in motion | `/api/work/recent` | 3.11c |
| Directives | `/api/directives`, categories, `/api/directive-reports`, unreviewed-count | 0.6, 2.13 |
| Decisions | `/api/decisions`, counts, answer, confirm, overturn | 4.1, 4.2c |
| Feedback | `/api/feedback`, counts, settings | 0 (enable), 2.18 |
| Graph | `/api/graph/health`, flags, jobs, entities, budget, tier, refresh, priority-folders | 5.12 (refresh in 0) |
| Vault | `/api/vault/tree`, preview, revisions, diff, conflicts, activity | 5.12 |
| Shares and channels | `/api/shares`, `/api/channels` | 5.12 |
| Messages | `/api/conversations`, `/api/messages/search` | 5.12 |
| Safety | `/api/lockdown`, `/api/alerts` | 4.10, 4.14, 5.12 |
| Audit and metrics | `/api/audit`, export, `/api/invocations`, `/api/metrics`, `/api/telemetry`, `/api/topology` | 5.12 |
| Onboarding | `/api/pcs/add`, `/api/onboarding` (approve), `/api/settings/onboarding`; `/onboard/enrol`, `/onboard/requests`, `/onboard/pickup` | 4.16–4.22 |
| Reset | `/api/reset/plan`, `/api/reset/parts` (read only) | 0.2 |
| Users | `/api/users` (create, list, patch, grants, reset-password, disable) | 5.12b |
| Deciders | `/api/teams/:id/deciders` (get, put), `/api/needs-you` | 5.12b |
| Blueprint | `/api/projects` and its items, ops, proposals, re-plan, report request, export; `/api/settings/blueprint` | 1.7–1.8, 2.24–2.25, 3.11b, 4.9b, 5.7 |
| Checkout | `POST /api/teams/:id/checkout`, `/api/checkouts/:id` and its leftover approval and render | 5.13–5.15 |

**Not in the story:**

- TOTP enrolment (`/api/totp/*`): it would make every later console login need a code during design reviews. `server/test` covers it.
- `POST /api/reset`: the story's hub is throwaway.
- Cancel and reissue for onboarding: covered by `onboarding.test.ts`. Deny, needs-changes, and a PC's suspend, reactivate and re-enrol run as side branches of Act 4 (4.18b, 4.18c, 4.24).

### Acceptance rows ([acceptance](acceptance.md))

| Row | Scripted in the story | Not scripted, and why |
|---|---|---|
| Identity | Distinct IDs for 29 keys on shared app keys (1.2, 1.4); logout (5.11) | Two real desktop conversations; token expiry (needs hours) |
| PC binding | Bound key through another PC's app key (1.2), alert (5.12) | — |
| Policy | Discovery shows a tool that is then denied (3.8); simulator agrees (0.7); temporary grant (4.3) and its expiry kept across a restart (4.13b–c) | Expiry itself firing (2 h; covered by tests). Under `--hub`, the restart is skipped |
| Operator console | Data for every screen; lockdown (4.10) and its survival across a restart, with sessions, pause and held messages (4.13b–c) | Keyboard, mobile and themes: not assertions |
| Vault and recovery | Stale write (3.12); external edit (3.1); conflict copy (3.13); restore (4.4) | Symlinks, junctions, case variants, interrupted writes: OS-level and covered by tests |
| Knowledge | Stale evidence and flags (3.3–3.5); independent review (4.7); private cause (3.5) | Revocation mid-delivery (timing-sensitive; regression suites) |
| Transfers | Inline channel, backpressure, close (2.19–2.23); per-file promote conflict (4.23) | Bridge relay interruption and disk commit: needs a paired bridge and process kill |
| Deployment | — | All of it: VM, restore, migration rollback, low storage, LAN proxy |
| Teams | Dedup (1.22); claim race (1.17); changes requested (2.14, 4.9); approved work sent back (2.14); a submission replaced and withdrawn in review, a stale verdict refused (4.9); checkpoint (5.4); worker denials (2.15, 3.7); held DM (1.13, 4.13); member removal (5.9) | Work loop on real desktop clients |
| Feedback | Merge and backers (2.17); triage (2.18); lockdown refuses filing but not find (4.11) | Rate limits (slow), console triage by keyboard |
| Onboarding | Hub side of enrol, request, pending refusal, approve with edit, pickup, confirm, `add_agents` (4.16–4.22) | Clean Windows/Linux PCs, `certutil`/`setx`, OS trust store, transport choice and installing Node or git: real PCs and a user's yes |
| Directives | Category filters, unknown category, a reported rule as a team suggestion, adopt (1.9–1.11, 2.13) | Console chips (not scripted) |
| Trust boundaries | Search marker only in `Classified/` (3.8); key-shaped fake (3.15); private cause (3.5) | Disposable real key in a note (it suspends a key; the suites cover it) |

The agents are scripted; a run with live models is not part of the story.

## 6. Layout and runner

### Repository layout

`eval/` is the Early Echo evaluation and holds everything:

| Path | Contents |
|---|---|
| `eval/README.md` | How to run it, the flags, and how to read the report |
| `eval/vault/` | The Early Echo vault (§2) |
| `eval/story/cast.mjs` | PCs, agents, teams, grants and directives, as data |
| `eval/story/act0.mjs` … `act5.mjs` | Steps: `{ id: '3.12', seat, call, args, expect, beat }` |
| `eval/story/lib.mjs` | Admin client, MCP client, assertions, coverage recorder and pacer |
| `eval/story/coverage.mjs` | The §5 matrix as data (every MCP tool, admin-API area and acceptance row), the gate, and the not-scripted reasons |
| `eval/run.mjs` | The runner |
| `eval/out/` | Reports; git-ignored |

`server/package.json` has `story` (`node ../eval/run.mjs`), and `dev:seed` runs the same runner against the running `dev:hub`. `dev-hub.mjs` copies `eval/vault/`.

### The story is the feature test suite

Each step has `expect`: `ok`, an error code, or a predicate on the result. The runner checks it on every call, and the run fails on the first mismatch, naming the step. After each act, it also checks invariants through the admin API: team statuses, task counts by state, open flags, pending requests and every team's plan (after Act 1 every team has one; before Act 4 none names a reveal term; by Act 5 each has changed at least once). Steps that wait on the watcher (3.1, 3.13) poll the vault activity endpoint for at most 10 s.

### Commands

| Command | What it does |
|---|---|
| `npm run story` | Starts a throwaway hub on `127.0.0.1` and a free port, with data in a temp directory and a fresh copy of `eval/vault/`. Runs Acts 0–5 at instant speed, writes the coverage report and stops the hub. Exits non-zero on a failed assertion or a failed gate. This is what CI and the test suite run. |
| `--until <act>`, `--from <act>` | Run only up to an act, or start at one. `--from` first replays the earlier acts at instant speed, so the state is exactly the same. |
| `--keep` | Leave the hub running afterwards, for console inspection. |
| `--hub` | Run against the already-running `dev:hub` instead of a throwaway one; this is what `npm run dev:seed` runs. It refuses a hub that already has story state unless `--reset` is given. |
| `--pace <factor>` | Replay for recording (below). |

Every URL is checked to be `127.0.0.1` before any call, in every mode: `--hub` refuses any other host, and also a hub that does not accept the dev credentials and report its own public URL as the 127.0.0.1 address it was reached on (an SSH tunnel to a real hub reports its own). Spawned hubs get a clean environment, not the caller's. A route counts as exercised only on an exact match with an answer below 400, or a refusal the step expects and `REFUSAL_ROUTES` in `coverage.mjs` lists; a row counts only after its step's checks pass, and not when the step is skipped. The runner never reads `~/.config/conclave`, prints no secret, and keeps keys in memory or in its own data directory.

### Pacing

By default every step runs as fast as the hub answers. For recording, `--pace 1x` (or `2x`, `0.5x`, any positive factor) replays the same story at a watchable speed:

- **Beats.** Each step has a `beat` in milliseconds: how long the moment should hold on screen at 1x. A login is about 300 ms, a message about 1.5 s, the CAP-014 external edit and the reveal in 4.3 about 4 s. Missing beats default by call type (reads 600 ms, writes 1.2 s, refusals 1.5 s). The wait after a step is `beat ÷ factor`.
- **Act pauses.** `--act-pause <seconds>` holds at each act boundary, with a title card logged to the console. `--act-pause key` waits for Enter.
- **One act.** `--from 3 --until 3 --pace 1x` records only Act 3.

Pacing only adds waits between steps; it never changes a call, an argument, an assertion or the order. The runner proves this:

- The coverage report records the pace, and the step-by-step outcome log must be identical with and without pacing.
- The test suite runs one act at `--pace 50x` and compares its outcome log with the instant run.
- Time-dependent states (the 3.14 stall) use their own fixed timer, so they behave the same at any pace.

### Coverage gate

- The MCP client records every call as `{tool, step, outcome}`. The admin client records `{method, route pattern, step}`, and each step lists the acceptance rows it exercises (from `coverage.mjs`).
- At the end, the gate fails if:
  - a tool in the hub's `tools/list` was never called;
  - a tool was only ever refused, unless it is on an explicit refusal-only list, which is empty;
  - an admin-API area or acceptance row marked scriptable in `coverage.mjs` was not exercised.
- The report is written to `eval/out/<run>/coverage.json` and `coverage.md`, with:
  - each tool, admin route and acceptance row, and the steps that hit it, with ok and refused counts;
  - the not-scripted items with their reasons;
  - bridge mode, listed as not covered.
- `npm test` gets a fast vitest guard: the static tool list from `server/src/mcp/*.ts` must equal the tools in `coverage.mjs`, so a new tool fails CI before anyone runs the story.
- `npm test` also runs the story itself at instant speed (`npm run story`); it must pass.

### Bridge

The story runs in inline mode. The bridge variants of `channel_open`, `share_upload`, `share_download` and `file_download` (`local_path`, `local_folder`) are not scripted, and the report lists them as not covered.

### Determinism

Names, texts and data come from fixed tables and a seeded generator. Timestamps are real, so relative times read naturally on the console. Re-running from `--reset` gives the same entities, the same order, the same outcome log and the same coverage, at any pace.

## Team plans

Every team keeps a plan its coordinator sets in Act 1 (Night Choir Capture when it is onboarded in Act 4), so the Blueprint card and screen are never empty. The data is `eval/story/plans.mjs`: requirements (must/should/could, with criteria) linked to milestones with due dates, written in the team's voice from the notes it owns. Case Command keeps the case's R1–R12 and M1–M7; the other teams' keys carry their initials (SL-, RE-, AN-, TK-, XB-, DB-, TN-, NC-), so a team requirement never reads as a case one. Each plan is the team's part of its own project blueprint, written with `bp_write` (`writePlan`): the story's keys map to blueprint keys, a requirement SL-R3 to FR-SL-03 (Case Command's R3 to FR-CC-03) in the team's module, a milestone SL-M2 to M2 in the team's project. What needs the operator (the module, new milestones, agreeing a requirement) comes back as a proposal, which the operator applies. Tasks carry `refs` to the plan items they serve.

| Team | Requirements | Milestones |
|---|---|---|
| Signals Lab | Echo model v2 validated; echo 47 explained; stability margin; echo decay profile; capture IDs; open questions | v2 issued, model frozen (M1), stability for the M2 review |
| Relay Engineering | Surge margin ≥ 15 %; surge detection 12 ms; emergency silence 200 ms; transmit sequence; power budget; shielding interface | Dish design review (M2), surge test, live listen (M4) |
| The Annex | The explanation survives an air-gapped capture; transmit power cap fixed in writing; timestamp fault model; dish panel 7 review; dish mount loads; Pellam build lot 7 | Firmware 7 explanation, explanation qualified (M3), dish mount to Tern-9 |
| Timekeepers | 4 ns stamps; lead-time error under 20 ms; echo-47 second timestamp; holdover repeat; clock supply (B-02) | Holdover repeat, clock for M4, pulsar-fix verified |
| Xenobiology | 3 EH per night; 9 EH in 30 days; shielded bunks; R12; frost sealed in SC-1; the ethics question; doses in EH | Keepers screened, dose model refit, bunks inspected (M5) |
| Disclosure Board | Independent review; no self-certification; traceability; hazard log current; the ethics question | Revision C reviewed, disclosure order (M6) |
| Tern-9 Keepers | ≤ 6 % added mass on the dish; dish mount 44 not cut before M4; bunks; receiver swap after M3; station log | Stubs (WP-03), mount 44, receiver swap and bunks, refit complete (M5) |
| Night Choir Capture | 600 transmissions above 0.32 captured independently; inspections; data shared; CAP-015 IDs | Block A, block B |

The plans move with the plot, one step per act, so every team's plan history fills:

- **Act 2 (2.24):** progress. SL-M1 is reached, RE-R4, AN-R4 and XB-R7 are met, and SL-R2 and TK-R3 are unclear: nobody can explain echo 47.
- **Act 3 (3.11b):** the blocker. CAP-014 returned the echo with no firmware, so AN-R1 and R4 are unclear, AN-M2, M3 and RE-M3 are missed, and M4 and Tern-9's milestones are at risk. The operator asks The Annex to re-plan.
- **Act 4 (4.9b):** the Q-9 redesign. The Firmware 7 patch is dropped, the ring-band shielding requirement is met, M3 and M4 move, and the answer becomes a requirement (R13, DB-R5). Echo 47 is explained through Disclosure case §9.
- **Act 5 (5.7):** disclosure meets the Disclosure Board's requirements and records the three conditions where they bind: the power cap (AN-R1, SL-R1, NC-M1), H-13 (R13, RE-M3) and the frost (XB-R5).

No plan names "substrate" or "fold test" (`REVEAL_TERMS` in `check-vault.mjs`) before the reveal in 4.3; the invariants and the eval-story test check it.

## Demo mode

A demo hub replays the story from the console. Set `DEMO_MODE=1` in its `.env`; it is off by default. The hub refuses to start with `DEMO_MODE` when `NODE_ENV=production` (the Docker image's setting) unless `DEMO_ALLOW_PRODUCTION=1` is set too, because Replay wipes the database. Without it the routes and the bar do not exist (`/api/demo` answers 404).

**Start exploring.** Open **Explore the case** in the demo bar, then choose **Replay through Act 3** to stop with two live choices. Answer Relay Engineering's question in **Needs you** and review Vesna's application in **Security → Requests**. The guide links to the case board and three evidence trails. **Find a panel or form** links to the work, team, evidence, security, and audit screens and suggests what to try in each.

**Follow your answer.** Choose a listed option on the receiver question to get the corresponding follow-up and evidence. Use **Replay** through Act 5 for the scripted disclosure and the last entry in Tern-9's station log. The interactive replay leaves a question from Saoirse in Case Command's Decisions. Choose who should be listening and the decision page opens a different follow-up for each choice. The guide also shows the follow-up from your saved answer. Replay starts the scripted timeline over, including its decisions.

**Explore the release handoff.** After Act 5, Home has a blocked watch task and a sealed-evidence request under **Needs you**, a timed Xenobiology pause under **For awareness**, and the clock-strip question in **Later** for the operator who started Replay. In Case Command, open the long Blueprint summary, the watch review rounds, and *An echo model for the dish* to compare the manuscript, delivered milestones, and claims with different levels of support. Security shows a completed routine collection for the Watch Console and a scoped lockdown of the Tern-9 PC. Those examples also leave entries in Audit.

**Try the collaborator console.** In **Security → Users**, reset the password for the fictional member **Ellis Vale** (`echo-guest`). Sign in in a separate browser session with the generated password, then finish first sign-in. Open **Case Command → Work** for the board and Topology. Open **Vault** for the **Case Command** and **Captures** folders. Every replay removes and recreates the member. Use the demo’s generated credentials only.

**The bar.** Choose the speed (Instant, 0.5×, 1×, 2×), the start and stop acts, and **Replay**. Both replay buttons ask once more before replacing the demo hub's data and vault. While a replay runs the bar shows the current step, a progress bar and **Stop**. On a phone the options sit behind a button and the progress takes a second line. The console under the bar refreshes as the story writes.

**What Replay does.** `POST /api/demo/replay {pace, from, until}` (operator session and CSRF, audited as `demo.replay` with who started it) answers `202`, then:

1. Resets the hub to the story's start: the operator reset of every part, plus the directives. Admin accounts and their sessions and the audit trail are kept, so you stay signed in and the audit log shows each replay.
2. Closes the app, replaces the files in `VAULT_DIR` with a fresh copy of `eval/vault`, and builds and listens again on the same port, in the same process. Nothing outside `DATA_DIR` and `VAULT_DIR` is touched; it refuses if `VAULT_DIR` and the story vault overlap. It also refuses, before touching anything, unless `VAULT_DIR` is empty or holds the `.conclave-demo` marker that a replay writes (hidden from agents): a real vault is never wiped. Start a demo hub on an empty vault folder; the first Replay fills it.
3. Runs the story runner (`eval/run.mjs`) in-process against the hub itself at the chosen pace, signing in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. That account must not have two-factor (TOTP) enrolled: the story cannot type a code, so its operator steps would fail. Earlier acts run instantly when Start is after Act 0. The restart steps (4.13b–c) are skipped, because the runner does not own this process.

One replay runs at a time (a second one is `409`). `POST /api/demo/stop` aborts between steps (audited as `demo.stop`); the hub stays as the story left it. `GET /api/demo` gives the story's acts and the replay's state, which the bar polls. Each replay ends with a `demo.finish` audit event (done, failed or stopped).

**Settings.** Demo mode shortens the knowledge graph's indexing debounce to 1 s and the vault scan to 5 s unless `GRAPH_DEBOUNCE_MS` or `VAULT_SCAN_SECONDS` are set, so curator jobs and external edits show up within the story. The image ships `eval/vault`, `eval/story` and `eval/run.mjs` at `/eval` (read only; nothing loads them without `DEMO_MODE`); `DEMO_STORY_DIR` points elsewhere.

## Runner behaviour

These follow from how the hub behaves:

- **Agents.** The cast tables name 29 people. The story ends with 32 (29, three onboarded; Tamsin stays a pending recruit).
- **One delivery model.** Since migration 0153 no direct message is held: in 1.13 both Dunmore's message to Fen (inside the draft Tern-9 Keepers) and Marguerite's (an outsider) arrive through `message_read`, and in 4.11 Orla's message reaches Teodor through `message_read` while Signals Lab is paused. The Mode column above records how each team was first set up; every team now acts when woken.
- **Lockdown blocks messages too.** The pause and the held message (4.10–4.11) come before the write lockdown (4.12–4.13), then the restart (4.13b–c) checks lockdown, pause, the temporary grant, a session token and the held message.
- **A review task goes to a worker or the coordinator.** Marguerite owns the Disclosure Board's review task in Act 5 (reviewer Ezra, 5.2); Hollis writes the order (5.6).
- **Task refs must be in the team's plan,** so only Case Command's tasks cite R-numbers.
- **§9 is added with `file_update`** (4.5b), since an exact-text patch cannot append a section.
- **One restore in 4.4.** The scratch note's restore covers `file_restore`; Dish array design is patched for Q-9 from its current revision instead of being rolled back first.
- **A completed team is checked through its queue** (5.10): Imani's `work_next` reports `team_done` and her `task_create` is refused, rather than a vault write.
- **The lab coordinator needs share rights** the onboarding template does not give: the operator adds them to its key and links it to Hesper (4.23).
- **Graph jobs** appear after the hub's indexing debounce (120 s by default). The throwaway hub and `dev:hub` set the new `GRAPH_DEBOUNCE_MS=1000`.
- **Invariants** run after each act (`eval/story/invariants.mjs`) and appear in the outcome log as `<act>.inv`.

