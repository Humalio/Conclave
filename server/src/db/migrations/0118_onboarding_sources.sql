-- Slice 2e, onboarding sources (docs/onboarding.md#content-from-onboarding): the approval records the Blueprint
-- proposal it filed, the request version it approved (a repeated approval of that version is replayed), and the items
-- it filed with their intended scope.
ALTER TABLE onboarding_requests ADD COLUMN proposal_id TEXT;
ALTER TABLE onboarding_requests ADD COLUMN approved_version INTEGER;
ALTER TABLE onboarding_requests ADD COLUMN filed TEXT NOT NULL DEFAULT '[]';
