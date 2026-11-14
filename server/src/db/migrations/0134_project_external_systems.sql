-- Outside systems of a project (docs/blueprint.md §3): the systems its Blueprint items may name in their outside
-- references (`external`, §2.2), each with an optional URL template the operator sets. JSON list of
-- {system, url_template}; NULL means any system, and no reference is a link.
ALTER TABLE projects ADD COLUMN external_systems TEXT;
