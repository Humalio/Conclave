-- Keywords on projects and teams (docs/proposals/team-keywords.md): the console's Teams view filters by them. Console only:
-- no MCP tool reads or writes them. The known keywords are the hub setting keywords.known (default in src/teams/keywords.ts).
CREATE TABLE project_keywords (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  keyword    TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, keyword)
);
CREATE TABLE team_keywords (
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  keyword    TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, keyword)
);
CREATE INDEX project_keywords_keyword ON project_keywords(keyword);
CREATE INDEX team_keywords_keyword ON team_keywords(keyword);
-- Every project and team there is today is Research & Development.
INSERT INTO project_keywords(project_id, keyword, position) SELECT id, 'Research & Development', 0 FROM projects;
INSERT INTO team_keywords(team_id, keyword, position) SELECT id, 'Research & Development', 0 FROM teams;
-- A new one gets Research & Development too, whatever creates it, while that keyword is known (no readable setting: the default list has it).
CREATE TRIGGER projects_default_keyword AFTER INSERT ON projects
  WHEN NOT EXISTS (SELECT 1 FROM system_settings WHERE key='keywords.known' AND json_valid(value) AND json_type(value)='array')
    OR EXISTS (SELECT 1 FROM system_settings s, json_each(CASE WHEN json_valid(s.value) THEN s.value ELSE '[]' END) j WHERE s.key='keywords.known' AND j.value='Research & Development')
BEGIN
  INSERT OR IGNORE INTO project_keywords(project_id, keyword, position) VALUES (NEW.id, 'Research & Development', 0);
END;
CREATE TRIGGER teams_default_keyword AFTER INSERT ON teams
  WHEN NOT EXISTS (SELECT 1 FROM system_settings WHERE key='keywords.known' AND json_valid(value) AND json_type(value)='array')
    OR EXISTS (SELECT 1 FROM system_settings s, json_each(CASE WHEN json_valid(s.value) THEN s.value ELSE '[]' END) j WHERE s.key='keywords.known' AND j.value='Research & Development')
BEGIN
  INSERT OR IGNORE INTO team_keywords(team_id, keyword, position) VALUES (NEW.id, 'Research & Development', 0);
END;
