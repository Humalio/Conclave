/**
 * Typed handout and checkpoint fields (docs/checkout.md §4, §8): handout text is L2, so every field that can reach the
 * restore prompt, the push list or a git call is checked here. Shared by the service (checkout_progress and
 * checkout_handout) and the render.
 */
export const PROVIDERS = ['claude_code', 'codex'] as const;
export type Provider = typeof PROVIDERS[number];
/**
 * Permission levels, lowest first: Claude Code's permission modes. A render can lower an agent's level, never raise it
 * above what it ran with (§5). Codex maps them to approval_policy and sandbox_mode.
 */
export const PERMISSIONS = ['plan', 'default', 'acceptEdits', 'bypassPermissions'] as const;
export type Permission = typeof PERMISSIONS[number];

/**
 * Codex (docs/checkout.md §6 step 5, §9 F4): prepared, unverified until the F4 spike (R5). Render offers only these
 * providers and refuses `codex` with `codex_unverified`, so no checkout can reach a client that nobody has run.
 */
export const OFFERED_PROVIDERS: readonly Provider[] = ['claude_code'];
export type CodexApproval = 'on-request' | 'never';
export type CodexSandbox = 'read-only' | 'workspace-write';
export interface CodexPermission { level: 'ask' | 'standard' | 'auto'; approval_policy: CodexApproval; sandbox_mode: CodexSandbox }
/**
 * A render's permission level as Codex settings. Three Codex levels for four Claude Code modes: plan reads only (ask),
 * default and acceptEdits write inside the folder and ask before anything else (standard), bypassPermissions stops
 * asking but stays inside the folder (auto). No level maps to danger-full-access. The client copy in
 * deploy/client/codex.mjs must match; server/test/codex-bridge.test.ts checks that.
 */
export function codexPermission(p: Permission): CodexPermission {
  switch (p) {
    case 'plan': return { level: 'ask', approval_policy: 'on-request', sandbox_mode: 'read-only' };
    case 'default':
    case 'acceptEdits': return { level: 'standard', approval_policy: 'on-request', sandbox_mode: 'workspace-write' };
    case 'bypassPermissions': return { level: 'auto', approval_policy: 'never', sandbox_mode: 'workspace-write' };
  }
}

/** Ref names: git's rules, simplified and strict; no leading '-', so a ref can never be read as an option. */
export const validRef = (r: unknown): r is string => typeof r === 'string' && r.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(r) && !r.startsWith('-') && !r.startsWith('/')
  && !r.endsWith('/') && !r.endsWith('.') && !r.endsWith('.lock') && !r.includes('..') && !r.includes('//') && !r.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'));
/** A commit: exactly 40 lower-case hex characters. */
export const validHead = (h: unknown): h is string => typeof h === 'string' && /^[0-9a-f]{40}$/.test(h);
export const validRemote = (r: unknown): r is string => typeof r === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r);
/**
 * A folder name under the project root: [A-Za-z0-9._-], at most 64 characters, starting with a letter or digit, so never
 * '-utouch' (git clone would read it as an option), '.', '..', '...' or '.git'.
 */
export const validFolder = (f: unknown): f is string => typeof f === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(f);
/**
 * A remote URL: https, ssh or scp-like, one token, no option-looking start, and a user and host that start with a letter or
 * digit (never ssh://-oProxyCommand=... or git@-oX:y). The host must also be on the repo host allowlist (§8, hostAllowed).
 */
export const validUrl = (u: unknown): u is string => typeof u === 'string' && u.length <= 400 && !/[\s\x00-\x1f\x7f]/.test(u) && !u.startsWith('-')
  && (/^(https|ssh):\/\/([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?\/\S+$/.test(u) || /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s-]\S*$/.test(u));

/**
 * The repo host allowlist (§8): the hosts a handout's repo URL may name. Kept in system settings (`checkout.repo_hosts`),
 * seeded from CONCLAVE_REPO_HOSTS, else this default. Exact host names, lower case, no wildcards.
 */
export const DEFAULT_REPO_HOSTS: readonly string[] = ['github.com'];
export const REPO_HOSTS_MAX = 50;
/** A host name on the allowlist: DNS labels of letters, digits and inner dashes, so never a leading '-', a '*' or a port. */
export const validRepoHost = (h: unknown): h is string => typeof h === 'string' && h.length <= 253
  && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(h);
/**
 * The host a remote URL names, lower-cased: https://[user@]host[:port]/path, ssh://[user@]host[:port]/path or the scp-like
 * user@host:path. Null for anything validUrl refuses, so a user part such as https://github.com@evil.example/x yields
 * evil.example, never github.com.
 */
export function repoHost(u: unknown): string | null {
  if (!validUrl(u)) return null;
  const m = /^(?:https|ssh):\/\/(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::\d+)?\//.exec(u) ?? /^[A-Za-z0-9][A-Za-z0-9._-]*@([A-Za-z0-9][A-Za-z0-9.-]*):/.exec(u);
  return m ? m[1]!.toLowerCase() : null;
}
/** Whether a repo URL's host is on the allowlist: exact and case-insensitive; a host starting with '-' never is. */
export function hostAllowed(url: unknown, allow: readonly string[]): boolean {
  const h = repoHost(url);
  return !!h && !h.startsWith('-') && allow.some((a) => a.toLowerCase() === h);
}
/** Agent-written leftover text is L2: control characters (newlines included) become spaces, so it stays one line of data. */
export const oneLine = (s: string): string => s.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').trim();
export const validModel = (m: unknown): m is string => typeof m === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$/.test(m);

/**
 * The leftover check (§4 step 4): every kind is reported, each cleaned (an empty list) or listed as exceptions with a
 * reason that the operator approves before the handout can be written.
 */
export const LEFTOVER_KINDS = ['worktrees', 'unmerged_branches', 'uncommitted_files', 'build_output', 'scratch', 'processes'] as const;
export type LeftoverKind = typeof LEFTOVER_KINDS[number];
export const LEFTOVER_LABELS: Record<LeftoverKind, string> = {
  worktrees: 'remaining worktrees (git worktree list)',
  unmerged_branches: 'unmerged local branches',
  uncommitted_files: 'uncommitted or untracked files',
  build_output: 'node_modules and build output in task folders',
  scratch: 'temp browser profiles and scratch files you created',
  processes: 'running dev hubs or background processes you started',
};
export const LEFTOVER_ITEM_MAX = 300;
export const LEFTOVER_REASON_MAX = 500;
export const LEFTOVERS_PER_KIND = 50;
