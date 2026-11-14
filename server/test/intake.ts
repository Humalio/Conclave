/**
 * Test fixture: the projects of teams created in this app take task_intake "open", so agents' task_create opens tasks
 * at once as before the backlog (task_rccuivx4jxcup75r). For tests whose intent is the task workflow after a task is
 * open; the backlog itself is covered by task-backlog.test.ts.
 */
import type { App } from '../src/app.js';

export function intakeOpen(app: App): void {
  const made = app.teams.onTeamCreated;
  app.teams.onTeamCreated = (id) => {
    made?.(id);
    app.db.prepare("UPDATE projects SET task_intake='open' WHERE id=(SELECT project_id FROM teams WHERE id=?)").run(id);
  };
}
