// Plumbing stub for EVAL_CLAUDE_BIN: no model, emits a stream-json result so the harness can be exercised offline.
let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => {
  const sid = 'stub-' + Math.random().toString(36).slice(2, 8);
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'stub answer 249 10%', session_id: sid, total_cost_usd: 0, num_turns: 1, usage: {} }));
});
