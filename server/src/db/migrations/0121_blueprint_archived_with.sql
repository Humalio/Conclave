-- Archive keeps parents and children consistent (docs/blueprint.md §6.1): each item archived by hand records the key
-- whose archive took it, so unarchiving that key brings back only what went with it. NULL for a live item, a status
-- report the retention rule archived, and an item archived before this column (unarchive treats those as taken with
-- their nearest archived ancestor, as before).
ALTER TABLE bp_items ADD COLUMN archived_with TEXT;
