/**
 * One reference grammar for everything an agent points at (F-18, docs/mcp.md "References"):
 *
 *   bp:<key>               a blueprint item of the caller's project (FR-TEAM-04, PAP-1/C3, ADR-007)
 *   share:<id>[@v<n>]      a share, optionally one published version (share:shr_abc@v2)
 *   task:<id>              a task (task:task_abc)
 *   /vault/<path>          a vault path; any path starting with / names a vault file or folder
 *
 * Blueprint evidence fields, task_submit's share and feedback links parse with this one function, so a ref written in one
 * place reads the same everywhere. Each caller still decides which kinds it takes and checks access itself.
 */

export type Ref =
  | { kind: 'bp'; key: string }
  | { kind: 'share'; id: string; version: number | null }
  | { kind: 'task'; id: string }
  | { kind: 'path'; path: string };
export type RefKind = Ref['kind'];

const BP = /^bp:([A-Z][A-Za-z0-9./-]{0,59})$/;
const SHARE = /^share:([A-Za-z0-9_-]{1,100})(?:@v(\d{1,9}))?$/;
const TASK = /^task:([A-Za-z0-9_-]{1,100})$/;

export class RefError extends Error {
  readonly code = 'invalid_argument';
  constructor(message: string) { super(message); }
}

/** Parse one reference; `allow` names the kinds this caller takes. Throws RefError naming the forms it accepts. */
export function parseRef(raw: string, allow: readonly RefKind[] = ['bp', 'share', 'task', 'path']): Ref {
  const s = String(raw).trim();
  let r: Ref | null = null;
  let m: RegExpExecArray | null;
  if ((m = BP.exec(s))) r = { kind: 'bp', key: m[1]! };
  else if ((m = SHARE.exec(s))) r = { kind: 'share', id: m[1]!, version: m[2] ? Number(m[2]) : null };
  else if ((m = TASK.exec(s))) r = { kind: 'task', id: m[1]! };
  else if (s.startsWith('/') && s.length <= 400 && !/[\0\r\n]/.test(s) && !/(^|\/)\.\.(\/|$)/.test(s)) r = { kind: 'path', path: s };
  if (!r || !allow.includes(r.kind)) throw new RefError(`${JSON.stringify(s.slice(0, 80))} is not a reference here. A reference is ${forms(allow)}.`);
  if (r.kind === 'share' && r.version === 0) throw new RefError('A share version starts at v1.');
  return r;
}

/** The forms a caller accepts, for its error messages. */
export function forms(allow: readonly RefKind[]): string {
  const all: Record<RefKind, string> = { bp: 'bp:<key>', share: 'share:<id>@v<n>', task: 'task:<id>', path: 'a vault path such as /vault/Folder/note.md' };
  const list = allow.map((k) => all[k]);
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list.at(-1)}` : list[0] ?? 'nothing';
}

/**
 * The references inside free text (an evidence field may say "run 3, see share:shr_x@v2"): every token that starts with
 * bp:, share: or task: followed directly by something, or with /vault/, must parse. Prose around them is left alone.
 */
export function scanRefs(text: string): Ref[] {
  const out: Ref[] = [];
  // A prefix counts only with something after it: "Blocked on the next task: rerun" and "share: 3 runs" are prose.
  for (const m of text.matchAll(/(?:^|[\s,;(\[])((?:bp|share|task):[^\s,;)\]]+|\/vault\/[^\s,;)\]]*)/g)) {
    out.push(parseRef(m[1]!.replace(/[.:]$/, '')));
  }
  return out;
}
