-- Legacy leftovers (docs/connector.md, "Old setup left on the PC"): whether the PC still holds pieces of the old setup (rollback copies
-- kept until `conclave migrate --finish`, or the old CA environment setting). One flag from the connector's check-in, never a path; NULL until reported.
ALTER TABLE connector_reports ADD COLUMN legacy_leftovers INTEGER;
