# Agent Hub — instructions for coding agents

- Read [docs/README.md](docs/README.md) first; it maps the design baseline.
- **Any change to the operator console (`server/public/`) follows [docs/design-guidelines.md](docs/design-guidelines.md).** Use its tokens, components and alignment rules, and run its review checklist before you call the change done. [docs/dashboard-ux.md](docs/dashboard-ux.md) says what each view must answer.
- To look at the console with realistic data, use the local design-review hub (`npm run dev:hub` and `npm run dev:seed` in `server/`, see [docs/getting-started.md](docs/getting-started.md)). It binds to 127.0.0.1 only. Never point design or test work at a real deployment.
- Run `npm test` in `server/` before finishing any server change.
