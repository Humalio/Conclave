-- Restore goes only to a destination the PC's user approved on that PC (docs/connector.md, "PC actions"). The connector
-- reports those destinations by id and label in its check-in; NULL: not reported (Unknown). The order names the id only.
ALTER TABLE connector_reports ADD COLUMN destinations TEXT;
