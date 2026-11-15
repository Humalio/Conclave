/**
 * The one reminder line (docs/connector.md, "The one reminder line"). It combines the agent's unread messages and unread
 * directives in fixed words. It is built here, on the PC, from the hub's counts: it never carries message text, a title
 * or an id, because messages stay L2 (data, never instructions). The only free text in it is a sender's label, and that
 * is shown only if it looks like a plain name (`LABEL_RE`, at most five words); anything else shows as "an agent".
 */

/** The one place that says what a sender label may look like: plain letters and digits, a few separators, 40 characters. */
export const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._·-]{0,39}$/u;
const MAX_WORDS = 5;

/** The name shown for one sender group from the hub: `{from: 'operator'|'agent', label}`. */
export function senderName(s) {
  if (s?.from === 'operator') return 'the operator';
  const l = typeof s?.label === 'string' ? s.label.trim() : '';
  return LABEL_RE.test(l) && l.split(/\s+/).length <= MAX_WORDS ? l : 'an agent';
}

const num = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);

/**
 * The line for the hub's counts `{total, senders: [{from, label, count}], directives}`, or null when nothing waits (or the
 * answer is not the shape the hub sends). Fixed words, numbers, and the sender names above, nothing else.
 */
export function reminderLine(s) {
  if (!s || typeof s !== 'object') return null;
  const total = num(s.total), directives = num(s.directives);
  if (!total && !directives) return null;
  const parts = [];
  if (total) {
    const groups = new Map();
    let counted = 0;
    for (const g of Array.isArray(s.senders) ? s.senders : []) {
      const c = num(g?.count);
      if (!c) continue;
      const name = senderName(g);
      groups.set(name, (groups.get(name) ?? 0) + c);
      counted += c;
    }
    const who = [...groups].map(([name, c]) => `${c} from ${name}`);
    if (counted < total) who.push(`${total - counted} from others`);
    parts.push(`${total} unread ${total === 1 ? 'message' : 'messages'}${who.length ? ` (${who.join(', ')})` : ''}`);
  }
  if (directives) parts.push(`${directives} unread ${directives === 1 ? 'directive' : 'directives'}`);
  const read = [total ? '`message_read`' : null, directives ? '`directives_read`' : null].filter(Boolean).join(' and ');
  return `Conclave: ${parts.join('; ')}. Read with ${read}.`;
}
