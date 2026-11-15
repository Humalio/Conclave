// Act 6 (optional, --scale): volume for console design reviews, built by scale-seed.mjs.
import { Pc } from './lib.mjs';
import { seedScale } from './scale-seed.mjs';

export default [
  {
    id: '6.1', title: 'Three more projects, 30 agents, 11 teams, directives and feedback at volume', beat: 3000,
    run: async (c) => {
      const conns = [];
      const mcpClient = async (appKey) => { const p = await new Pc(c.hub.base, 'scale', appKey, c.rec).connect(); conns.push(p); return p.client; };
      try {
        await seedScale({
          get: (p) => c.op.get(p), post: (p, b) => c.op.post(p, b), put: (p, b) => c.op.put(p, b), patch: (p, b) => c.op.patch(p, b),
          mcpClient, log: c.log, sleep: (ms) => c.sleep(ms),
          step: async (name, fn) => { try { return await fn(); } catch (e) { throw new Error(`${name}: ${e.message}`); } },
        });
      } finally { for (const p of conns) await p.close(); }
    },
  },
];
