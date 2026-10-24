/** PC setup, bridge pairing and bridge keys (SPECIFICATION §3-4, design/08 Setup and Bridge protocol). */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import { hmacHex, randomToken, safeEqualHex, sha256Hex } from '../util/crypto.js';
import { KeyError } from '../keys/keys.js';
import type { Keys, Machine } from '../keys/keys.js';

export const SETUP_TTL_MS = 60 * 60 * 1000;
export const PAIRING_TTL_MS = 15 * 60 * 1000;
export const PART_SIZE = 50_000;
const SETUP_RE = /^ah_set_([a-z2-7]{12})_([a-z2-7]{32})$/;
const BRIDGE_RE = /^ah_brg_([a-z2-7]{12})_([a-z2-7]{32})$/;

export type OsName = 'windows' | 'macos' | 'linux';
export type SetupStatus = 'none' | 'waiting_install' | 'waiting_pairing' | 'waiting_folder_approval' | 'done';
export interface Folder { path: string; status: 'proposed' | 'approved' | 'rejected'; proposed_at: number; decided_at: number | null }
export interface SetupKeyRow {
  id: string; machine_id: string; key_id: string; verifier: string; created_at: number; expires_at: number; used_at: number | null;
  setup_called_at: number | null; pairing_hash: string | null; pairing_expires_at: number | null; paired_at: number | null;
}
type MachineX = Machine & { bridge_version: string | null; bridge_last_seen_at: number | null; os: string | null; setup_status: string };

export function normaliseOs(os: string): OsName {
  const o = String(os).toLowerCase();
  if (['windows', 'win32', 'win', 'win64'].includes(o)) return 'windows';
  if (['macos', 'darwin', 'mac', 'osx'].includes(o)) return 'macos';
  if (o === 'linux') return 'linux';
  throw new KeyError('invalid_argument', 'os must be windows, macos or linux');
}

export function findBridgeFile(explicit?: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [explicit, join(here, '../bridge/agent-hub-bridge.mjs'), join(here, '../../../bridge/agent-hub-bridge.mjs'), join(process.cwd(), '../bridge/agent-hub-bridge.mjs')].filter(Boolean) as string[];
  const f = candidates.find((c) => existsSync(c));
  if (!f) throw new Error('bridge program not found; set BRIDGE_FILE');
  return f;
}

export class Setup {
  private bridgeText: string | null = null;
  constructor(private readonly db: Db, private readonly pepper: string, private readonly audit: Audit, private readonly keys: Keys, private readonly hubUrl: string, private readonly bridgeFile?: string) {}

  // ───── bridge program ─────
  bridge(): { text: string; sha256: string; parts: string[] } {
    if (this.bridgeText === null) this.bridgeText = readFileSync(findBridgeFile(this.bridgeFile), 'utf8').replace(/\r\n/g, '\n');
    const text = this.bridgeText;
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += PART_SIZE) parts.push(text.slice(i, i + PART_SIZE));
    return { text, sha256: sha256Hex(text), parts: parts.length ? parts : [''] };
  }

  // ───── setup keys ─────
  createSetupKey(machineId: string, actor: Actor): { secret: string; expires_at: number } {
    const pc = this.keys.machine(machineId);
    if (!pc) throw new KeyError('not_found', 'PC not found');
    if (pc.status !== 'active') throw new KeyError('invalid_state', 'this PC is not active');
    const keyId = randomToken(8).slice(0, 12), secret = randomToken(20).slice(0, 32), now = Date.now();
    tx(this.db, () => {
      this.db.prepare('UPDATE setup_keys SET used_at=? WHERE machine_id=? AND used_at IS NULL').run(now, machineId);
      this.db.prepare('INSERT INTO setup_keys(id,machine_id,key_id,verifier,created_at,expires_at) VALUES (?,?,?,?,?,?)')
        .run(`stp_${randomToken(10)}`, machineId, keyId, hmacHex(this.pepper, secret), now, now + SETUP_TTL_MS);
      this.db.prepare("UPDATE machines SET setup_status='waiting_install' WHERE id=?").run(machineId);
    });
    this.audit.event(actor, 'pc.setup_key_create', { kind: 'pc', id: machineId });
    return { secret: `ah_set_${keyId}_${secret}`, expires_at: now + SETUP_TTL_MS };
  }

  /** Validate a presented setup key for the PC of the calling app key. */
  verifySetupKey(presented: string, machineId: string | null): SetupKeyRow {
    const m = SETUP_RE.exec(String(presented).trim());
    const row = m ? this.db.prepare('SELECT * FROM setup_keys WHERE key_id=?').get(m[1]!) as unknown as SetupKeyRow | undefined : undefined;
    if (!m || !row || !safeEqualHex(row.verifier, hmacHex(this.pepper, m[2]!))) throw new KeyError('invalid', 'unknown setup key');
    if (row.used_at !== null) throw new KeyError('expired', 'this setup key was already used or replaced');
    if (row.expires_at <= Date.now()) throw new KeyError('expired', 'this setup key expired');
    if (row.machine_id !== machineId) throw new KeyError('wrong_pc', 'this setup key belongs to another PC');
    const pc = this.keys.machine(row.machine_id);
    if (!pc || pc.status !== 'active') throw new KeyError('suspended', 'this PC is not active');
    return row;
  }

  /** setup_pc: record os and folders, return ordered steps. part 0 also issues a new pairing code. */
  setupPc(row: SetupKeyRow, o: { os: string; proposedFolders: string[]; part: number }) {
    const os = normaliseOs(o.os);
    const b = this.bridge();
    if (o.part < 0 || o.part >= b.parts.length) throw new KeyError('invalid_argument', `part must be 0..${b.parts.length - 1}`);
    const now = Date.now();
    let pairingCode: string | null = null;
    if (o.part === 0) {
      const raw = randomToken(8).slice(0, 12);
      pairingCode = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`.toUpperCase();
      tx(this.db, () => {
        this.db.prepare('UPDATE setup_keys SET setup_called_at=?, pairing_hash=?, pairing_expires_at=? WHERE id=?').run(now, sha256Hex(raw.toLowerCase()), now + PAIRING_TTL_MS, row.id);
        this.db.prepare('UPDATE machines SET os=? WHERE id=?').run(os, row.machine_id);
        for (const p of o.proposedFolders) {
          this.db.prepare("INSERT INTO machine_folders(machine_id,path,status,proposed_at) VALUES (?,?,'proposed',?) ON CONFLICT(machine_id,path) DO NOTHING").run(row.machine_id, p, now);
        }
      });
      this.refresh(row.machine_id);
      this.audit.event({ kind: 'agent', id: null }, 'pc.setup_pc', { kind: 'pc', id: row.machine_id }, { os, folders: o.proposedFolders });
    }
    return {
      os, part: o.part, parts: b.parts.length, content: b.parts[o.part]!, sha256_whole: b.sha256, bytes_whole: Buffer.byteLength(b.text),
      steps: this.steps(os, b.sha256, pairingCode), pairing_code: pairingCode, pairing_expires_in_s: pairingCode ? PAIRING_TTL_MS / 1000 : null,
    };
  }

  private steps(os: OsName, sha: string, code: string | null) {
    const dir = os === 'windows' ? '$env:USERPROFILE\\.agent-hub' : '$HOME/.agent-hub';
    const file = os === 'windows' ? `${dir}\\agent-hub-bridge.mjs` : `${dir}/agent-hub-bridge.mjs`;
    const hub = this.hubUrl;
    const verify = os === 'windows' ? `certutil -hashfile "${file}" SHA256` : os === 'macos' ? `shasum -a 256 "${file}"` : `sha256sum "${file}"`;
    const quote = (s: string) => os === 'windows' ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", "'\\''")}'`;
    const pair = `node "${file}" pair ${quote(hub)} ${quote(code ?? '<PAIRING-CODE from part 0>')}`;
    let service: { title: string; file?: { path: string; content: string }; commands: string[] };
    if (os === 'windows') {
      service = { title: 'Register the bridge to start at logon (Task Scheduler, PowerShell)', commands: [
        '$bridgeNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source',
        `$bridgeAction = New-ScheduledTaskAction -Execute $bridgeNode -Argument ('"{0}" run' -f "${file}")`,
        '$bridgeUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
        '$bridgeTrigger = New-ScheduledTaskTrigger -AtLogOn -User $bridgeUser',
        '$bridgeSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
        'Register-ScheduledTask -TaskName AgentHubBridge -Action $bridgeAction -Trigger $bridgeTrigger -Settings $bridgeSettings -User $bridgeUser -RunLevel Limited -Force',
        'Start-ScheduledTask -TaskName AgentHubBridge'] };
    } else if (os === 'macos') {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.agenthub.bridge</string>\n<key>ProgramArguments</key><array><string>NODE_PATH</string><string>${file}</string><string>run</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n</dict></plist>\n`;
      const p = '$HOME/Library/LaunchAgents/com.agenthub.bridge.plist';
      service = { title: 'Register the bridge with launchd (substitute absolute paths, XML-escaped, before writing the file)', file: { path: p, content: plist },
        commands: [`plutil -lint "${p}"`, `launchctl bootout "gui/$(id -u)/com.agenthub.bridge" 2>/dev/null || true`, `launchctl bootstrap "gui/$(id -u)" "${p}"`] };
    } else {
      const unit = `[Unit]\nDescription=Conclave bridge\n\n[Service]\nExecStart="NODE_PATH" "%h/.agent-hub/agent-hub-bridge.mjs" run\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
      const p = '$HOME/.config/systemd/user/agent-hub-bridge.service';
      service = { title: 'Register the bridge as a systemd user service (substitute the absolute Node executable for NODE_PATH)', file: { path: p, content: unit },
        commands: ['systemctl --user daemon-reload', 'systemctl --user enable agent-hub-bridge', 'systemctl --user restart agent-hub-bridge'] };
    }
    return [
      { n: 1, title: 'Get the bridge program', detail: `Create ${dir} and write the bridge program to ${file}. It is delivered in the parts returned by setup_pc (call again with part=1..N-1 if parts > 1); concatenate them in order with no changes. Requires Node 24 or newer.` },
      { n: 2, title: 'Verify the program', commands: [verify], expect_sha256: sha, detail: 'The SHA-256 must equal sha256_whole. If not, stop and tell the administrator.' },
      { n: 3, title: 'Pair this PC', commands: [pair], detail: 'The pairing code works once and expires in 15 minutes. If it expired, call setup_pc with part=0 again.' },
      { n: 4, ...service },
      { n: 5, title: 'Check progress', detail: 'Call setup_status with the setup key. The administrator must approve the folders you proposed on the Setup page; then it reports done.' },
    ];
  }

  // ───── status ─────
  status(machineId: string): { status: SetupStatus; missing: string[] } {
    const sk = this.db.prepare('SELECT * FROM setup_keys WHERE machine_id=? ORDER BY created_at DESC LIMIT 1').get(machineId) as unknown as SetupKeyRow | undefined;
    if (!sk) return { status: 'none', missing: [] };
    if (!sk.paired_at) {
      return sk.setup_called_at ? { status: 'waiting_pairing', missing: ['bridge pairing (run the pair command)'] } : { status: 'waiting_install', missing: ['setup_pc not called yet'] };
    }
    const pending = (this.db.prepare("SELECT COUNT(*) n FROM machine_folders WHERE machine_id=? AND status='proposed'").get(machineId) as { n: number }).n;
    return pending ? { status: 'waiting_folder_approval', missing: [`${pending} folder(s) await the administrator`] } : { status: 'done', missing: [] };
  }
  /** Recompute and store setup_status (closing is done by closeIfDone, after the agent saw "done"). */
  refresh(machineId: string): SetupStatus {
    const s = this.status(machineId).status;
    this.db.prepare('UPDATE machines SET setup_status=? WHERE id=?').run(s, machineId);
    return s;
  }
  /** The setup key is used up once setup_status has reported done. */
  closeIfDone(machineId: string): void {
    if (this.status(machineId).status === 'done') this.db.prepare('UPDATE setup_keys SET used_at=? WHERE machine_id=? AND used_at IS NULL').run(Date.now(), machineId);
  }

  // ───── folders ─────
  folders(machineId: string): Folder[] {
    return this.db.prepare('SELECT path,status,proposed_at,decided_at FROM machine_folders WHERE machine_id=? ORDER BY path').all(machineId) as unknown as Folder[];
  }
  decideFolder(machineId: string, path: string, status: 'approved' | 'rejected', actor: Actor): Folder[] {
    const r = this.db.prepare('UPDATE machine_folders SET status=?, decided_at=? WHERE machine_id=? AND path=?').run(status, Date.now(), machineId, path);
    if (Number(r.changes) === 0) throw new KeyError('not_found', 'folder not found');
    this.audit.event(actor, `pc.folder_${status}`, { kind: 'pc', id: machineId }, { path });
    this.refresh(machineId);
    return this.folders(machineId);
  }

  // ───── pairing ─────
  pair(code: string, os: string | undefined, version: string | undefined): { bridgeKey: string; machine: Machine } {
    const raw = String(code).toLowerCase().replace(/[^a-z2-7]/g, '');
    const row = raw.length === 12 ? this.db.prepare('SELECT * FROM setup_keys WHERE pairing_hash=?').get(sha256Hex(raw)) as unknown as SetupKeyRow | undefined : undefined;
    if (!row || row.paired_at !== null || !row.pairing_expires_at || row.pairing_expires_at <= Date.now() || row.used_at !== null) throw new KeyError('invalid', 'invalid or expired pairing code');
    const pc = this.keys.machine(row.machine_id);
    if (!pc || pc.status !== 'active') throw new KeyError('suspended', 'PC not active');
    const keyId = randomToken(8).slice(0, 12), secret = randomToken(20).slice(0, 32), now = Date.now();
    tx(this.db, () => {
      this.db.prepare("UPDATE bridge_keys SET status='revoked', revoked_at=? WHERE machine_id=? AND status<>'revoked'").run(now, row.machine_id);
      this.db.prepare('INSERT INTO bridge_keys(id,machine_id,key_id,verifier,created_at,last_seen_at) VALUES (?,?,?,?,?,?)').run(`brk_${randomToken(10)}`, row.machine_id, keyId, hmacHex(this.pepper, secret), now, now);
      this.db.prepare('UPDATE setup_keys SET paired_at=?, pairing_hash=NULL WHERE id=?').run(now, row.id);
      this.db.prepare('UPDATE machines SET bridge_version=?, bridge_last_seen_at=?, os=COALESCE(?, os) WHERE id=?').run(version ?? null, now, os ? normaliseOs(os) : null, row.machine_id);
    });
    this.refresh(row.machine_id);
    this.audit.event({ kind: 'system', id: null }, 'pc.bridge_paired', { kind: 'pc', id: row.machine_id }, { version: version ?? null });
    return { bridgeKey: `ah_brg_${keyId}_${secret}`, machine: this.keys.machine(row.machine_id)! };
  }

  // ───── bridge key ─────
  /** Authenticate a bridge key. Throws KeyError (invalid/revoked/suspended) otherwise. */
  verifyBridgeKey(presented: string): { keyRowId: string; machine: Machine } {
    const m = BRIDGE_RE.exec(String(presented).trim());
    const row = m ? this.db.prepare('SELECT * FROM bridge_keys WHERE key_id=?').get(m[1]!) as unknown as { id: string; machine_id: string; verifier: string; status: string } | undefined : undefined;
    if (!m || !row || !safeEqualHex(row.verifier, hmacHex(this.pepper, m[2]!))) throw new KeyError('invalid', 'unknown bridge key');
    if (row.status !== 'active') throw new KeyError(row.status, `bridge key is ${row.status}`);
    const pc = this.keys.machine(row.machine_id);
    if (!pc || pc.status !== 'active') throw new KeyError('suspended', 'PC not active');
    return { keyRowId: row.id, machine: pc };
  }
  heartbeat(keyRowId: string, machineId: string, version: string | null): void {
    const now = Date.now();
    this.db.prepare('UPDATE bridge_keys SET last_seen_at=? WHERE id=?').run(now, keyRowId);
    this.db.prepare('UPDATE machines SET bridge_last_seen_at=?, bridge_version=COALESCE(?, bridge_version) WHERE id=?').run(now, version, machineId);
  }
  bridgeInfo(machineId: string) {
    const k = this.db.prepare("SELECT status,last_seen_at FROM bridge_keys WHERE machine_id=? AND status<>'revoked' ORDER BY created_at DESC LIMIT 1").get(machineId) as { status: string; last_seen_at: number | null } | undefined;
    const pc = this.keys.machine(machineId) as MachineX;
    const seen = pc.bridge_last_seen_at;
    return { paired: !!k, key_status: k?.status ?? null, version: pc.bridge_version, last_seen_at: seen, online: seen !== null && Date.now() - seen < 90_000, os: pc.os, setup_status: pc.setup_status };
  }
  approvedFolders(machineId: string): string[] {
    return (this.db.prepare("SELECT path FROM machine_folders WHERE machine_id=? AND status='approved' ORDER BY path").all(machineId) as { path: string }[]).map((r) => r.path);
  }
}
