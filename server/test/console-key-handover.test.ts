/**
 * Key handover, console side (docs/onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc): the Rotate
 * sheet keeps "Could this key have leaked?" and says Rotate and send to <PC> when the key's PC runs the connector, else
 * Rotate and show the key once; the key's Overview shows "Waiting for the PC user to allow it on <PC>" with Cancel, green
 * once confirmed; a new key for a connector PC opens its page instead of a one-time view. The hub side is key-handover.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');

describe('Rotate sheet (source)', () => {
  it('keeps the leak question and names the delivery from the hub\'s target', () => {
    for (const t of ['Could this key have leaked?', 'Yes, or I\'m not sure', 'No, this is routine', 'Rotate the app key…', 'Rotate and show the key once']) expect(js, t).toContain(t);
    expect(js).toContain('`Rotate and send to ${esc(tgt.name)}`');
    expect(js).toContain("const reason = leak === 'yes' ? 'suspected_leak' : 'routine';");
    expect(js).toContain('await post(`${kp}/rotate`, { reason })');
    // After a possible leak the sheet says to rotate the PC's app key too.
    expect(js).toContain('Rotate that app key too, or re-enrol the PC.');
    // Show-once: the key must be put on its PC by hand.
    expect(js).toContain('must be put on its PC by hand');
    expect(js).toContain("'No connector will pick this key up: put it on its PC by hand.'");
  });
  it('after a possible leak on a connector PC: the app key is replaced, and the new pairing code is shown once', () => {
    expect(js).toContain("Leak rotation not finished: rotate again or revoke");
    expect(js).toContain("Held because it may have leaked: rotate it again or revoke it.");
    expect(js).toContain("The current key is held until then: its logins are refused.");
    expect(js).toContain("so that app key is replaced too. You get a new pairing code once: the user of ${esc(tgt.name)} must pair the connector again with it. This key is held at once: its logins are refused. Until then no agent on ${esc(tgt.name)} can reach the hub (their sessions end; their keys stay valid)");
    // "Rotate the app key…" is offered only when no connector replaces it.
    expect(js).toContain("leak === 'yes' && appId && !tgt ?");
    expect(js).toContain("if (r.pairing) { openD('key', r.key.id, true); return rotPairSheet(r); }");
    expect(js).toContain('function rotPairSheet(r)');
    for (const t of ['Pair the connector on ${pc} again', 'It works once and is not shown again', 'no agent on <b>${esc(pc)}</b> can reach the hub', 'their session keys stay valid', 'conclave pair --hub', 'Copy code']) expect(js, t).toContain(t);
  });
  it('Re-enrol says the agents\' keys are handed over, and an agent the hub refuses is Key refused', () => {
    expect(js).toContain("'Old app key revoked. The agents\\' keys stay valid and are handed over once the PC is paired again'");
    expect(js).toContain("key_refused: ['Key refused', 'bad']");
  });
  it('says when the PC does not hold the key (not_on_pc)', () => {
    expect(js).toContain('nop = ho.not_on_pc');
    expect(js).toContain('`Not on ${nop.pc.name}: this PC does not hold the key`');
  });
  it('the old collection UI and routes are gone', () => {
    for (const t of ['/collect`', 'collect/cancel', 'collect/prompt', 'Rotate and collect', 'Codex wake picks the key up', 'single-use pickup code']) expect(js, t).not.toContain(t);
  });
});

describe('Key handover card (source)', () => {
  it('shows the wait with Cancel, and green once confirmed with a link to the new key', () => {
    expect(js).toContain('`Waiting for the PC user to allow it on ${oh.pc.name}`');
    for (const t of ['Not allowed on the PC yet', 'Picked up, not confirmed yet', 'The current key works until then.', 'Open the new key', "['Sent', 'Allowed', 'Confirmed']"]) expect(js, t).toContain(t);
    expect(js).toContain('post(`${kp}/handover/cancel`)');
    expect(js).toContain("'Cancelled: the current key goes on working'");
    // The 15 s refresh stops when the card on screen belongs to another key.
    expect(js).toContain("$('#hoCard')?.dataset.key !== k.id");
  });
  it('a rotation or new key that went by handover opens the key\'s page, not a one-time view', () => {
    expect(js).toContain("if (r.handover) { toast(`Sent: waiting for the user of ${r.handover.pc.name}`); return openD('key', r.key.id, true); }");
    expect(js).toContain("if (res.handover) { toast(`Sent: waiting for the user of ${res.handover.pc.name}`); return openD('key', res.key.id); }");
  });
  it('the Needs you row names the wait and opens the key', () => {
    expect(js).toContain("key_handover: ['Waiting for the PC user', 'key']");
    expect(js).toContain("case 'key': return `data-key=");
  });
  it('has styles for the status tones and steps', () => {
    for (const s of ['.col-status.ok', '.col-status.wait', '.col-steps li.done', '.col-steps li.now']) expect(css, s).toContain(s);
  });
});
