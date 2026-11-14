-- A new team's source set after setup (docs/onboarding.md#setup-progress): the operator's answer on the team's Setup card,
-- kept beside the approved request so approved_body stays the record of what was approved. JSON {from, ref?, note?, by, at};
-- NULL until the operator sets it, and the setup view reads it before the request's own source.
ALTER TABLE onboarding_requests ADD COLUMN source_set TEXT;
