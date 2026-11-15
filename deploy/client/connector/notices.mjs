/**
 * What the connector tells the PC's user, and what it reports to the hub about a removal, in FIXED words only
 * (review-v2 §6 "Notifications carry fixed hub words only"). Nothing from the hub, an agent, a message or the file system
 * (no path, no name, no key) is ever put into these sentences; the only variable is a count. The local screen and
 * `conclave uninstall` list the kept paths to the user separately, on this PC only.
 */
export const NOTICES = {
  setup_step: 'Conclave needs you to finish a setup step on this PC. Open the connector to continue.',
  needs_you: 'Conclave needs your answer on this PC. Open the connector to see it.',
  disconnect_waiting: 'A hub disconnected this PC. Conclave will finish removing its files the next time it can reach the hub.',
  disconnect_done: 'A hub disconnected this PC, and Conclave removed what that hub had put here. Your repositories, chats and settings are unchanged.',
  disconnect_kept: 'A hub disconnected this PC. Conclave removed what that hub had put here, except {count} item(s) you had changed, which it kept. Open the connector to see them.',
  cleanup_off: 'A hub disconnected this PC. Remote cleanup is off on this PC, so nothing was removed from it.',
  uninstall_done: 'Conclave was removed from this PC. Your repositories, chats and settings are unchanged.',
  uninstall_kept: 'Conclave was removed from this PC, except {count} item(s) you had changed, which it kept and listed.',
  uninstall_offline: "This PC may still be enrolled on a hub. Ask the hub's admin to disconnect it in the console (Disconnect this hub from this PC).",
};

/** The fixed sentence for a code, with a count filled in where it has one. An unknown code gives a fixed fallback. */
export function notice(code, { count } = {}) {
  const t = NOTICES[code] ?? 'Conclave has something for you on this PC. Open the connector to see it.';
  return t.replace('{count}', String(Number.isInteger(count) && count >= 0 ? count : 0));
}

/** Why an item was kept, in fixed words (for the local list and for the hub's "left" sentences). */
export const KEPT_WHY = {
  edited: 'You changed it after Conclave set it up.',
  not_json: 'Its file is not valid JSON, so Conclave did not touch it.',
  unreadable: 'Its file could not be read.',
  redirected_path: 'Its path goes through a link, a junction or another reparse point, so Conclave did not follow it.',
  reparse_unknown: 'Conclave could not check its path for links and reparse points, so it did not touch it.',
  identity_changed: 'Its folder was replaced since it was registered.',
  folder_missing: 'Its folder is gone.',
  folder_not_registered: 'Its folder is not registered with Conclave.',
  wrong_place: 'It is not where Conclave puts that kind of setting.',
  wrong_pointer: 'It is not a setting Conclave owns.',
  in_use: 'It is in use; close the program using it and run the removal again.',
  unknown_kind: 'Conclave does not know what it is.',
  keyfile_unreadable: "This PC's Conclave key file cannot be read.",
  keyfile_unsafe: "This PC's Conclave key file can be read by other users.",
};
const KIND_WORD = {
  mcp_entry: 'An MCP entry in an agent folder', mcp_approval: 'An MCP approval in an agent folder', codex_entry: 'A Codex entry in an agent folder',
  hook: 'A hook in an agent folder', git_exclude: 'A git exclude line in an agent folder', trust_flag: 'A folder trust setting',
  registry_entry: 'A folder record', token_cache: 'A token cache', portable_git: 'The private git', key_section: "A hub's keys",
};

/** The `left` sentences for the hub: one per kept item, kind and reason in fixed words, at most 20, never a path. */
export function left(kept) {
  return kept.slice(0, 20).map((k) => `${KIND_WORD[k.kind] ?? 'An item'} was kept. ${KEPT_WHY[k.reason] ?? 'Conclave could not remove it safely.'}`);
}
