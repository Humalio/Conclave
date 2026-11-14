-- What each status means in a project (docs/blueprint.md §3): the operator's one sentence per status of fr, nfr and ac,
-- as {kind: {status: sentence}}. Text only: the status names stay the same in every project and the hub enforces none
-- of it. bp_read {rules: true} returns the sentences as L0, and the console shows them as tips on the status pills.
ALTER TABLE projects ADD COLUMN status_meanings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(status_meanings));
