-- Directive project reach follows team memberships (docs/directives.md#project-reach): a project scope and a project
-- exemption name a Blueprint project by its id, no longer the agents' free-text project label. Each stored label
-- becomes the id of the project whose key it is, else whose name it is (an open project first, ignoring case).
-- A project exemption keeps every agent it kept off before: an agent whose label matched and that is in no live team
-- of the project gets an agent exemption of its own, and an exemption whose label names no project is removed as
-- history once those agent exemptions stand in for it. A project scope whose label names no project keeps it and
-- reaches nobody until the operator picks a project. No notices are sent; directive versions keep their labels.
CREATE TEMP TABLE m117 (label TEXT PRIMARY KEY, pid TEXT);
INSERT INTO m117(label, pid)
SELECT l, (SELECT p.id FROM projects p WHERE p.id = l OR lower(p.key) = lower(l) OR lower(p.name) = lower(l)
           ORDER BY (p.id = l) DESC, (lower(p.key) = lower(l)) DESC, (p.status = 'closed'), p.created_at, p.id LIMIT 1)
FROM (SELECT scope_ref AS l FROM directives WHERE scope_kind = 'project' AND scope_ref IS NOT NULL AND scope_ref <> ''
      UNION SELECT target_ref FROM directive_exemptions WHERE target_kind = 'project' AND removed_at IS NULL AND target_ref <> '');

INSERT OR IGNORE INTO directive_exemptions(id, directive_id, target_kind, target_ref, note, created_by, created_at)
SELECT 'dex_' || lower(hex(randomblob(10))), x.directive_id, 'agent', ag.id,
       'Kept off project ' || x.target_ref || ' before reach followed teams', NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM directive_exemptions x
JOIN m117 mm ON mm.label = x.target_ref
JOIN agents ag ON COALESCE(ag.project, '') = x.target_ref
WHERE x.target_kind = 'project' AND x.removed_at IS NULL AND ag.archived_at IS NULL AND ag.status <> 'archived'
  AND NOT EXISTS (SELECT 1 FROM team_members m JOIN teams t ON t.id = m.team_id
                  WHERE m.agent_id = ag.id AND m.removed_at IS NULL AND t.status NOT IN ('done', 'stopped') AND t.project_id = mm.pid);

UPDATE OR IGNORE directive_exemptions SET target_ref = (SELECT pid FROM m117 WHERE label = target_ref)
WHERE target_kind = 'project' AND removed_at IS NULL AND (SELECT pid FROM m117 WHERE label = target_ref) IS NOT NULL;

UPDATE directive_exemptions SET removed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000, removed_by = 'migration:0117'
WHERE target_kind = 'project' AND removed_at IS NULL AND target_ref NOT IN (SELECT id FROM projects);

UPDATE directives SET scope_ref = (SELECT pid FROM m117 WHERE label = scope_ref)
WHERE scope_kind = 'project' AND (SELECT pid FROM m117 WHERE label = scope_ref) IS NOT NULL;

DROP TABLE m117;
