/**
 * The PC user's local switches (docs/connector.md "The connector's report"): ~/.config/conclave/preferences.json, the same file as `conclave usage on|off`. Only the
 * PC user changes them, with `conclave settings`; the hub only reads them in the check-in. A switch never set is null.
 */
import { join } from 'node:path';
import { readJson, atomicWrite } from './paths.mjs';

export const SWITCHES = { 'auto-update': 'auto_update', 'remote-cleanup': 'remote_cleanup', 'remove-connector-with-last-hub': 'remove_connector_with_last_hub', 'usage': 'usage_opt_in' };
const path = (home) => join(home, 'preferences.json');
/** The file as an object; a file that holds something else (a list, a string, a number) reads as empty, so a switch can still be set. */
const readPrefs = (home) => { const p = readJson(path(home), {}); return p && typeof p === 'object' && !Array.isArray(p) ? { ...p } : {}; };

/** `{auto_update, remote_cleanup, remove_connector_with_last_hub, usage_opt_in}`, each true, false or null. */
export function readSettings(home) {
  const s = readPrefs(home);
  const out = {};
  for (const k of Object.values(SWITCHES)) out[k] = typeof s[k] === 'boolean' ? s[k] : null;
  return out;
}

/** Sets one switch by its command-line name (`auto-update`) to on or off. */
export function setSwitch(home, name, on) {
  const key = SWITCHES[name];
  if (!key) throw new Error(`unknown switch ${name}`);
  const s = readPrefs(home);
  s[key] = !!on;
  atomicWrite(path(home), JSON.stringify(s, null, 2) + '\n');
  return readSettings(home);
}

/** Updates are on unless the PC user turned them off. */
export const autoUpdateOn = (home) => readSettings(home).auto_update !== false;
