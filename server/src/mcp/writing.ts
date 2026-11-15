// What agents write that a person reads, and how they report problems with Conclave itself.
// One source for the server instructions, team_info, the onboarding prompt and the tool parameter descriptions.

/** Who reads agent text, and how to write it. The console renders Markdown (server/public/app.js prose()). */
export const WRITING = 'Titles, summaries, reports, questions, reasons and notes are read by the operator, a person, in the Conclave console. '
  + 'Write them for that person: plain language and full sentences, the outcome first, then what it means for them. '
  + 'Name things as a person knows them (a requirement by its title, a file by its name); add an id, key or tool name only where the reader needs it, in `backticks`. Name agents by their label, not their id. '
  + 'Markdown renders: short paragraphs, - lists, **bold**, `code`, [links](https://…). No raw JSON, stack traces or code-style labels such as done=3.';

/** How to write a blueprint item: the operator reads it in the console (docs/blueprint.md §2.7). */
export const BP_WRITING = 'Blueprint items are read by the operator, a person, in the console: write them for that person, not as notes for yourself. '
  + 'Title: what the item is, in words a person knows; no private codes. '
  + 'Body: the first sentence says the requirement, the result or the decision in plain words; for a result, what came out and the number that matters. '
  + 'Put commit hashes, paths, ledger and run ids, declarations and raw statistics under a "## Records" heading at the end of the body; the console folds it. '
  + 'Keep a code only if it is a blueprint key or a glossary term; otherwise say it in words, or propose a term (kind term, key G-<code in lower case>, title the code, body one plain sentence, fields.aliases). Terms need the operator, so put all of them in one write. '
  + 'An acceptance criterion says given, when and then, and its title says what is checked. '
  + 'Cite sources as [[note]] links to vault files. Anything evidence rests on (ledgers, records, registers) lives in the vault; repo paths and commits go under Records. '
  + 'Tracker story ids, pull request numbers and other outside ids go in fields.external as {system, id}, not in the body.'
  + ' A question to someone outside the team says in fields.purpose what the team does today and what each answer would change; when work waits on an answer, link the question to that work with blocks. Ask the operator with team_ask, not with a Blueprint question. Mark a requirement unclear rather than guess, and ask the operator what is unclear with one team_ask that names the requirement; set unclear_ask to that question. Or put the question itself in unclear_ask, as its text or {question, options, recommended}, and the write asks it for you.';

/** When to file feedback: problems, and steps that could cost fewer calls, tokens or minutes. */
export const FEEDBACK_HABIT = 'If a Conclave tool is missing, broken or confusing, makes you work around it, or a step costs more calls, tokens or time than it should, '
  + 'check `feedback_find` and back an existing report or file one with `feedback_file`: once per problem, not per occurrence, and without private content. '
  + 'Ideas that would make your work faster or cheaper are welcome too; give your estimate of what it would save (cost).';

/** The end-of-task nudge: one line on task_submit and team_complete results, only for a team with feedback_nudge on (docs/feedback.md). */
export const FEEDBACK_NUDGE = 'If something in Conclave slowed this task down, file it: `feedback_find`, then `feedback_file` or back the existing report.';

/** Suffix for a parameter whose text the operator reads. */
export const forOperator = (what: string) => `${what} The operator reads it: plain words for a person, Markdown renders.`;
