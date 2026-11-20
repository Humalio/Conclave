# Exporting a project Blueprint

The hub owns the current project records, including requirements and acceptance criteria, decisions, architecture, milestones, and risks. Use **Export** in the Blueprint console or `GET /api/projects/:id/export.md` to read them as Markdown. Access follows the project's export rules. A local review hub can also export through the script.

```bash
cd server
node scripts/export-blueprint.mjs --hub <local-hub-url> --project <key> --export ../blueprint-export.md
```

Treat exports as project data and keep them outside the maintained docs. See [platform requirements](../requirements.md) for the supported product contracts and [Blueprint](../blueprint.md) for the data model and access rules.
