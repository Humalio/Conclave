# Connect a computer and start a team

Use this guide when a person or an AI agent will work on a new computer. The **hub** hosts the console, tasks, and vault. The **connector** runs on the computer where an agent works and signs it in.

## With the Conclave connector

1. **In the console**, open **Security → PCs → Add PC** and name the computer. Keep the hub address, the short certificate fingerprint, and the pairing code available for the next step.
2. **On the computer where the agents will run**, download and run the signed connector installer. On the local pairing screen, enter the hub address, the fingerprint, and the code. The pairing code expires after 30 minutes.
3. **Copy the setup prompt** from the console and open it in your coding client. Describe the team you want. For example, ask for a team with a writer and a reviewer to keep a grant calendar. Check the draft request before sending it.
4. **Approve the request** in the console. On the computer, use **Continue setup** to create the agent folders and see how to open each one.
5. **Open the agents.** When an agent makes its first authenticated call from its own client, the console marks it **Connected**.

You enter the pairing code on the local screen. The prompt you give to a coding agent contains no credential. If you already use the older setup, see [Moving an existing PC](#moving-existing-pcs-to-the-connector).

### The installer

Get the installer from the Conclave repository's GitHub Releases page. The installer checks the release signature with the public key it carries, then verifies the version, platform, and contents before installing. If your computer only reaches the local network, get the same installer and signed files from your administrator. Compare the signing-key fingerprint and installer checksum with the release page through a trusted connection. See [How connector releases are signed](connector-release.md).

Node must be on the PC first. When it is missing, the Releases page and the console give the install command for the platform; installing Node never needs an app restart afterwards, because the connector calls Node by its absolute path.

Run the installer with Node.js. Use `node` followed by the name of the downloaded `conclave-install-<version>.mjs` file. To install from files supplied by your administrator, add `--from` followed by the folder containing the release files. The installer saves the connector, enables it at sign-in under your account, and opens the local pairing screen. The release script writes it from the template `deploy/client/install.mjs`, filling in the version and the public release keys; the template itself refuses to run.

### Pairing

Add PC creates the PC, its app key and a single-use **pairing code**, shown only in the console. The code is valid for 30 minutes, is bound to this hub's identity and HTTPS origin as well as its CA pin, and is entered on the connector's local pairing screen. **Make a new code** voids the old one. A change of the hub's CA or origin is accepted only after the PC's user confirms it on that screen.

- **The screen.** `conclave setup` opens it in the browser. It listens only on `127.0.0.1`, on a random port, and opens with a one-time token in its address: the first visit trades the token for a cookie, and the token is dead after that. Every request must name that exact address as its host, and every form must come from that same origin, so another web page in the user's browser cannot post to it. It stops after an hour without use, or when its command is stopped.
- **The CA check comes first.** The console shows the code together with the hub's address and the short form of its CA fingerprint. The user enters all three. Before it sends anything, the connector opens TLS to the hub, checks that the certificate it was given was issued by the CA the hub serves, and compares that CA's fingerprint with the one entered. Only on a match does it ask the hub for its identity, and only when that identity is new on this PC, or the same as before with the same CA and address, does it send the code. On a mismatch it says "This is not the hub you were given: its certificate does not match" and sends nothing.
- **A known hub that changed.** When this PC already has a section for that hub's identity with another CA or address, the screen says so and pairs only after the user confirms that their administrator told them of the change. The old section stays until then.
- **The code** never appears in a prompt, a chat, a command line, a URL or a log: the user types it into the screen, and the screen never shows it back.
- **After pairing** the connector holds the hub's section in `keys.json` (its identity, address, CA and app key) and the PC page shows the **Paired** step.

### The prompt and the request

The prompt the operator copies for a connector PC carries no secret: it names the PC and asks the coding agent to draft the team request with the user, check it with `conclave setup request --file <path> --check`, and file it with `conclave setup request --file <path>`. `conclave setup withdraw` withdraws the PC's current request, also one an earlier Re-enrol reopened for a new pickup that setup cannot finish; agents that already joined their team stay, and a new request can be filed. After a Re-enrol that fell back (the PC held none of the keys), those agents' keys are revoked: they stay in their team, shown as **Key refused**, until the operator archives them or gives them new keys. The request's rules are the ones in [The request](#the-request). The agent never handles a key, and the connector reads none into its output.

### Setting up the folders

After the operator approves, `conclave setup` (on its screen, or in a terminal) picks up the keys into the hub's section of `keys.json`, builds each agent's folder under the chosen root, writes its instructions file, and registers the folder with the connector: its `.mcp.json` entry runs `conclave mcp <folder>` by Node's absolute path, approved in the folder's own `.claude/settings.json`, and the folder is trusted in `~/.claude.json` (see [connector.md](connector.md#folder-trust)). Every change is recorded in the manifest. Then it confirms the pickup.

If git is missing on Windows, setup offers to install a private copy of git into the connector's folder, with no admin rights and no change to the user's own git settings. The connector checks it against the version and hash in its own signed release. When no Git for Windows is installed, setup also sets `CLAUDE_CODE_GIT_BASH_PATH` for the user (`HKCU\Environment`, no admin), which is how Claude Code finds it; this is the one change outside the connector's folder, and it is recorded for uninstall. A git the user installs is always preferred, and uninstall removes the private copy and the variable. On macOS and Linux, setup gives the install command for the platform.

- **It's an offer.** The screen asks "Git is missing. Install a private copy for Conclave only (about 50 MB, no admin rights)?" and installs only on yes. If you decline, setup shows the Git installation command for your platform.
- **What it is.** MinGit 2.56.1 (64-bit), pinned by version and SHA-256 in the connector's signed release; any other file is refused. After unpacking, its `usr\bin\sh.exe` (GNU bash) is copied to `usr\bin\bash.exe`, and the copy is checked against the original.
- **How the agents find it.** Claude Code's shell is the private bash, which brings its own git. Claude Code reads its Git Bash path only from the environment it starts with (the folder's own settings are too late), so setup sets `CLAUDE_CODE_GIT_BASH_PATH` in the user's environment (`HKCU\Environment`, no admin), only when no Git for Windows is installed. A Claude Desktop that was already open reads it after it is closed and opened once; the screen says so. The connector itself calls the private git by its absolute path. The copy and the variable are manifest entries, removed by uninstall.
- **Codex.** Use Git for Windows for Codex. The private Git installation is documented for Claude Code. [Git on Windows](connector.md#git-on-windows)

### Starting the team

For each agent, the connector offers one way to open it on that surface: **Open agent** in Claude Desktop, one copyable command in a terminal or for Codex. Each names the folder and where the chat will show. Each agent is **Waiting for approval**, **Ready to open** or **Connected**, and one failed agent can be retried alone.

- **Claude Desktop.** The screen shows the exact folder with a Copy button and says where the chat will appear: "In Claude Desktop, start a new Code session in this folder; the chat shows under that folder". **Open agent** also opens that folder in a file window. Nothing outside Desktop can start a Desktop chat, so this is the one click the user makes per agent.
- **Terminal (Claude Code).** One command per agent: it changes to the folder and starts `claude` with a fixed first message that tells the agent to read its directives and its team.
- **Codex.** The same, with `codex -C <folder>`.
- **Connected** comes from the hub: the agent's first authenticated call from its own new client. A setup login or the service's check-in does not count. An agent whose session keys the hub no longer accepts (revoked or suspended) is **Key refused by the hub**, never Connected; when the hub refuses the PC's own app key, `conclave setup status` says so and shows no agent as Connected.
- **Retry** rebuilds one agent's folder and entries; the others are not touched. `conclave check --folder <folder>` checks that folder's connection.

### Continue setup

**Continue setup**, on the connector's local screen or in the console, picks up where setup stopped, bound to the same installation and request. Nothing is pasted again.

The connector keeps its setup state per hub on the PC (`onboarding/<hub>.json`, no secrets): the request, the root folder, each agent's folder and its last result. Closing the app or the screen while the request waits loses nothing: `conclave setup` (or the console's "Continue setup on the PC") reopens the screen at the same step. In the console, the PC page's setup timeline shows the same steps and states, and each step that waits names its next action and who takes it.

### Folder trust

Claude Code keeps its own copy of `~/.claude.json` and can save it over a folder's trust. When the trust entry of a folder the connector registered has disappeared and the folder is unchanged, the connector puts it back, by key, never over a newer file. When the user turned trust off, or the folder's identity or agent config changed, it doesn't: the session and the PC page offer **Repair connection**, which asks the user. Each folder's MCP server lives in its own `.mcp.json`.

### Secure connection

The connector uses HTTPS and verifies the hub's certificate authority from pairing. This avoids changing the operating system's certificate store or restarting the app for certificate setup. If setup installs private Git for Claude Code on Windows, reopen Claude Desktop so it can pick up the new Git Bash setting.

For an existing installation, see [Migration](connector.md#moving-an-old-pc-conclave-migrate). To remove it, see [Uninstall and disconnect](connector.md#uninstall-and-disconnect).

## Legacy setup reference

The following sections describe the older `setup.mjs` flow for computers that have yet to move to the connector. Its setup prompt includes a single-use enrolment code. Use the [connector flow](#with-the-conclave-connector) for a new connector installation.

## Hub backend

Server code: `server/src/onboarding/` (service and `/onboard/*` routes), `server/src/admin/onboardingApi.ts`, the [schema baseline](../server/src/db/migrations/0100_v1_baseline.sql) (`enrolment_codes`, `onboarding_requests`, `onboarding_events`, `onboarding_slots`; `credentials.onboarding_enabled_at`, `machines.mcp_transport`, `teams.project`). Tests: `server/test/onboarding.test.ts`.

| Point | Behavior |
|---|---|
| Hub calls | Only the `/onboard/*` HTTP endpoints below; there are no onboarding MCP tools. |
| Enrolment secret | Enrolment gives the PC's existing app key a fresh secret in place (same key id, policy and capability); a retry with the same nonce does it again, so the previous secret stops working. Another nonce before confirm counts as reuse. `POST /onboard/enrol/confirm` takes `{nonce}`. |
| Member role | A slot's `team_role` is its team membership role (so team permissions apply); the request's role `name` becomes the agent's role and its `job` the role detail. Playbooks are per team role. |
| Labels, variables, folders | Label `<team> <role>[ <n>]` (numbered when the role has more than one agent or the team already has one); `session_var` and folder derived from it, unique among the PC's open slots. |
| Ceiling | The approval's `template_id` per slot, else rules generated from the role's folders: `read` gives `fs.list/read/search`, `write` adds `fs.create/update/history`, plus `tool:file_*`. A write on the vault root needs `confirm_root_write: true`. |
| Start | `start_when_set_up` (default `true`) on approve: a new team starts at confirm. |
| PC key errors | Every bearer route on `/onboard/*` audits a bad PC key (`authentication_events`) and counts it per address in `pickup_fail` (10 an hour, then `rate_limited` and an `onboarding_auth_fail` alert). Capability off is `403 capability_off`; lockdown `423`. |
| Client files | `GET /onboard/client/setup.mjs`, `agent-hub-headers.mjs`, `onboarding-prompt.md` (LF line ends, `x-content-sha256` header) and `GET /onboard/client/manifest`; from `deploy/client/` (`CLIENT_DIR` overrides).  |
| Prompt | Rendered by Add PC and Re-enrol from `deploy/client/onboarding-prompt.md`, placeholders `{{HUB_URL}}`, `{{LAN_LINE}}`, `{{LAN_URL}}`, `{{PC_NAME}}`, `{{CA_SHA256}}`, `{{SETUP_SHA256}}`, `{{HELPER_SHA256}}`, `{{ENROL_CODE}}`. The wording is in [the user guide](#user-guide). |
| CA | `GET /onboard/ca.crt` serves `CA_CERT_FILE`; its fingerprint is the SHA-256 of the certificate's DER (`X509Certificate.fingerprint256`, lowercase hex without colons). `LAN_URL` adds the plain-HTTP URL to the prompt. |
| Console | Add PC and Re-enrol on the PCs page and the PC page; the approval screen `#ob/<id>`; Settings → Onboarding is the **Settings** sheet on the PCs page. `GET /api/onboarding/pcs` returns every PC's code state, MCP transport and pending count in one call, for the PCs table. |
| Long poll | `GET /onboard/requests/:id?wait_s=0..45[&version=n]` returns at once when the request changes (or already differs from `version`). |

## User guide

Follow these steps only for the older `setup.mjs` flow. For current setup, see [With the Conclave connector](#with-the-conclave-connector).

**Operator.** In the console, **Add**, then **A new PC**, with the PC's name and coding agent (or `POST /api/pcs/add {name}`). Copy the prompt it shows and give it to the person at that PC directly (not through a shared chat): it carries a single-use code. When the request arrives, open it, check the computed access, edit if needed and **Approve** (`POST /api/onboarding/:id/approve`). Nothing else: the keys are created when the PC collects them, and the team starts once setup completes.

**User, on the new PC.** Open any coding agent (Claude Code, Codex or another; desktop app or terminal) in the folder that should hold the agents' folders, paste the prompt, and add what you want at the end in plain words. The agent then:

1. checks Node.js and git, and offers the exact install command if either is missing (it runs it only if you agree). It does not probe the hub's HTTPS address itself: this PC does not trust the hub's certificate yet, so that would fail with a certificate error. `enrol` checks the hub with the pinned certificate instead;
2. downloads `setup.mjs` and the headers helper into `~/.config/conclave/` and checks both hashes;
3. enrols the PC (`setup.mjs enrol`): the PC key goes straight into `~/.config/conclave/keys.env`;
4. drafts the request, shows you a one-screen summary, and files it only after you agree (`setup.mjs request`);
5. asks how the agents' client should reach the hub: install and trust the hub certificate (HTTPS, after the client restarts), or the LAN's plain HTTP (keys cross the network unencrypted at login);
6. waits for the approval (`setup.mjs wait`): the script waits, not the model. If the approval takes longer than the command may run, Claude ends with "Still waiting for approval…"; say "continue" (or paste the prompt again) once it is approved;
7. on approval, the script collects the keys, builds a folder per agent under `<this folder>/<project>/`, tests each login, and Claude starts the coordinator in its folder; the coordinator starts the rest.

If anything fails, `node ~/.config/conclave/setup.mjs check` says which check and why (one line each).

**Folder trust can be lost once.** The script marks each agent folder as trusted in `~/.claude.json` while the Claude Code session that ran the prompt is still open, and Claude Code keeps its own copy of that file: when the session (or the app) saves it, the trust entries can disappear. The symptom is a trust dialog, or no hub tools, in an agent's session. Run `node ~/.config/conclave/setup.mjs check`: it re-applies the missing trust (after one backup) and reports `trust <VAR>: re-applied`. Then start the agent's session again. The prompt tells the user this at the end. Rerunning the prompt, or any command, resumes where it stopped. Later requests from the same PC use the same prompt ("add two developers to …").

| Command | What it does |
|---|---|
| `enrol --hub <url> --ca-sha256 <hex> [--stdin] [--replace]` | Pins the CA (downloads `/onboard/ca.crt`, checks its fingerprint, keeps it as `~/.config/conclave/hub-ca.pem`), reads the code from `onboarding/enrol-code` (or stdin), swaps it for the PC key, writes `AGENT_HUB_APP_KEY`, `AGENT_HUB_URL`, `AGENT_HUB_CA`, confirms, deletes the code file. Already enrolled with the same code: runs `check`. A PC key in `keys.env` that the script did not write is replaced only with `--replace`. `--code` is refused. |
| `schema` | The request fields, limits and an example, for the agent drafting it. |
| `request --file <path> [--check] [--amend]` | Validates locally (the hub's rules, up to 20 problems), prints the one-screen summary; files, or amends the current request. |
| `status`, `withdraw` | The PC's pending requests; withdraw the current one. |
| `wait --transport https\|http [--lan-url <url>] [--root <dir>] [--replace] [--max-minutes <n>]` | Long-polls (45 s per call, the first at once) and prints a line only on a change. Approved: collision check, pickup, `keys.env`, confirm (with the transport), folders, a login test per folder; prints names, folders, results and the coordinator's folder. Default `--max-minutes 1`, so a plain run ends inside Claude Code's 2-minute default command timeout; the prompt passes `--max-minutes 9` with a 600000 ms (10-minute) timeout. Either way it exits on its own with "Still waiting for approval…" (exit 3) before the tool would kill it. |
| `check [--https \| --http --lan-url <url>]` | The [doctor](#doctor). The flags switch every onboarded folder and `AGENT_HUB_URL` to the other transport first. |
| `trust [--apply]` | The commands that make Claude Code trust the hub's CA: Windows `certutil -user -addstore Root` and `setx NODE_EXTRA_CA_CERTS`; elsewhere the `NODE_EXTRA_CA_CERTS` line for the shell profile. `--apply` runs them (after the user agrees). |

Exit codes: 0 done, 1 failed, 2 usage, 3 still waiting, 4 changes asked, 5 request denied, withdrawn or cancelled.

## Client

Client code: [deploy/client/setup.mjs](../deploy/client/setup.mjs) (Node 18+, no dependencies) and [deploy/client/onboarding-prompt.md](../deploy/client/onboarding-prompt.md). End-to-end test: `server/test/onboarding-client.test.ts`.

| Point | Behavior |
|---|---|
| Pinning | Every script call to an `https://` hub trusts only the pinned CA (Node's `ca` option, hostname checked). Only the CA download itself skips verification, and its bytes are then checked against the fingerprint. An `http://` hub URL is accepted only on loopback (development and tests). Redirects are never followed. |
| State file | `~/.config/conclave/onboarding/state.json`: hub, CA fingerprint, PC, enrolment nonce and a SHA-256 of the code (to tell a rerun from a new code), transport, LAN URL, and per request its id, state, root folder, `pickup_id`, the variables written and each agent's label, role, variable, folder and instructions (needed to rebuild folders after confirm). No secrets. |
| Resume | Enrol: the same code reuses its nonce (the hub reissues). Pickup: if `keys.env` already holds the keys of the latest `pickup_id`, a rerun only confirms; a confirm refused as "replaced" picks up again. After confirm, a rerun rebuilds folders and reruns the login tests from the state file, without a pickup. |
| Project in the status | The status view carries `project` (the approved project name), so folders go to `<root>/<project>/<folder>`. |
| Collisions | Before pickup: a variable already in `keys.env` that this setup did not write (unless `--replace`), or a target folder whose `.agent-hub.json` names another variable. Nothing is picked up when one is found. |
| Login test | Runs the helper with the folder argument, as Claude Code would; only its exit status and stderr line are used, its headers never printed. |
| Output | Every line passes a filter that replaces anything shaped like an app key, session key, enrolment code or key pickup code with `[redacted]`, as a second line of defence. |
| `key` | Redeemed a key prompt's pickup code. **Refused from this release on:** keys now reach a PC by [key handover](#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc). Needs no onboarding state: the hub, the CA and the PC key come from `keys.env` (`AGENT_HUB_URL`, `AGENT_HUB_CA`, `AGENT_HUB_APP_KEY`). Deletes the code file after writing the key. |
| Test hook | `CONCLAVE_SETUP_CRASH_AFTER=keys_written` or `confirmed` stops the script at that point (exit 137); used by the end-to-end test to prove resume. |
| Starting the team | The script prints `coordinator folder: <path>`; the prompt has Claude start a session there. The team itself is already running: the hub starts it at confirm. |

## 1. One key: Add PC and the prompt

**Add** in the console (the header, the More sheet on phones) opens on "What do you want to add?": **A new PC** (connect a new PC to Conclave and set up its security and keys; its first team comes with it) or **A team** (on a PC that is already connected, with the active PCs named; it opens the existing New team screen). There is no choice for an agent: the console has no flow that adds a new agent to a team on its own PC (a coordinator's recruit request does that, and **Members**, **Add member** adds an agent that already has a session key). The PCs page keeps a contextual **Add PC**, which opens straight on the new-PC screen with Back to the choices. The **Connect a new PC** screen says "Use this to connect a new PC to Conclave and set up its security and keys", asks for the PC name, the PC's coding agent (Claude Code, Codex or another agent) and, optionally, what its team should do, then shows the prompt with "Paste this into <the agent> on <the PC>" and a waiting line. The chosen agent only words the screen: the hub has no field for it, and the PC's agent reports its own client in the request. It is one click with one field, the PC's name. It:
- creates the PC (`POST /api/pcs` as today) and its **app key** (`kind: "app_key"`, `machine_id`, no expiry), with the onboarding capability on;
- creates a single-use **enrolment code** for that app key;
- shows a ready-to-copy **prompt**.

The prompt carries no long-lived secret. It holds:

| Item | Why |
|---|---|
| The hub URL (HTTPS, and the LAN plain-HTTP URL if the hub has one) | Where to enrol. |
| The SHA-256 fingerprint of the hub's CA certificate | The script pins it for every call it makes (see [HTTPS](#https-without-os-trust)). |
| The SHA-256 of `setup.mjs` and of the headers helper | Claude checks the downloads against them. |
| The enrolment code | Swapped once for the app key by the script. Worthless once used. |
| The steps for Claude | Short, fixed text written by the hub: check, download, enrol, draft, file, wait, set up, start. The user adds what they want at the end in plain words. |

The prompt is the user's own message to their Claude session, so its steps are the user's instructions. Everything the hub later returns to the script (status, operator notes) is data.

### The enrolment code

| Rule | Value |
|---|---|
| Format | `cnv_enrol_` + 26 characters of base32, 128 random bits. Stored only as a verifier, like every key. |
| Single use | `POST /onboard/enrol` swaps it for the app key secret, which the script writes to `keys.env`. After the script confirms, the code is dead. |
| Lifetime | An unused code from Add PC or Re-enrol PC does not expire. A [checkout](checkout.md) issues no code. The console shows "Code not used yet · <age>" on the PC and on Home; the operator revokes it, or re-enrols, instead of waiting for a timer. |
| Retry before confirm | Like pickup: if the response was lost, the same code and the script's enrolment nonce (kept in the state file) return a fresh app key secret and revoke the previous one. `POST /onboard/enrol/confirm` ends it. |
| Used again after confirm | Refused (`invalid_state`) with a warning alert `enrolment_code_reused`: the prompt was rerun on another PC, or someone copied it. Nothing is issued. |
| Brute force | Failed codes count per source address in a persisted counter (`enrol_fail`); 10 failures an hour lock that address out for the hour and alert. |
| Re-enrol PC | For a reinstalled, replaced or lost PC, or one whose connector key went astray. Issues a new single-use code and prompt and a new app key, and revokes the PC's old app keys and any unused enrolment code at once. **On a PC that runs the connector**, every agent key still onboarded there (an agent a checkout moved away is left alone) is handed over to the new app key by one [key handover](#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc): the PC user pairs the connector again with the new code, allows the handover once, and the old session keys are revoked only at confirm. Nothing is picked up again by hand. If the connector holds none of those keys (the PC was reinstalled or replaced), it reports so, and the hub falls back to the old way below. **On a PC with no connector**, and in that fallback, the session keys are revoked at once, and the pickup reissues fresh keys for each of the PC's collected requests that still have an agent on it (see [later](#later)); `conclave setup withdraw` (or `setup.mjs withdraw`) withdraws such a reopened request instead. |

### The app key and its onboarding capability

The app key and its onboarding permission have **no timer**. Both last until the operator acts.

| Rule | Value |
|---|---|
| The PC key | An ordinary app key with no expiry: the key the PC's agents log in with. It ends only when the operator suspends or revokes it. |
| Live logins | An app key allows **100 live logins** by default (`max_live_sessions`); a login over the limit is refused as `rate_limited`, and logins already live go on. The admin edits the limit per key, 1 to 500, in Keys → the app key → Overview → **Login limit** (`PUT /api/keys/:id/live-limit {max_live_sessions}`, audited as `key.live_limit` with the old and the new limit); it applies at the next login. The default was 20 until migration `0137`, which moved every app key still at exactly 20 to 100 and left any other value (such as 60) as it was. |
| The capability | On for keys made by Add PC; the operator can turn it off or on in Keys (`PUT` / `DELETE /api/keys/:id/onboarding`) or give it to an existing app key. In the console the key list says "Onboarding on" in an app key's line, and the key's Overview has an **Onboarding** row ("On since <date>" or "Off") with a switch: on is one click, off asks first. |
| What it allows | Without a session token, and nothing else: filing, amending and withdrawing a request, and pickup ([endpoints](#endpoints)). Reading the key's own requests needs no capability. No vault, team, message or policy action. |
| How long it lasts | No timer; a pickup does not end it. Over time the key can file any number of requests: new projects, new teams, or more agents in a team it onboarded. |
| One pending request per key | At most one request that is not yet decided or collected (see [states](#states)). A second is refused with `invalid_state` naming the pending one: "This PC already has a pending request: `<id>` "<team name>", filed <time>, waiting for <the approval / key pickup / your changes>." Nothing is recorded for the refused call. |
| Rate limits (per app key) | Defaults, editable in console **Settings → Onboarding** (`onboarding.file_per_hour`, `onboarding.file_per_day`). Filing, amending and withdrawing: 5 an hour and 20 a day (refused second requests count). Status: 120 an hour (long polls count once per call). Pickup: 10 an hour; failed pickup authentication uses a `pickup_fail` counter like `setup_fail`. `rate_limited` carries `retry_after_s`; counters persist. |
| PC or key state | A suspended PC, or a suspended or revoked app key, refuses all of it. Capability off: filing and pickup refused, status readable. Lockdown: filing and pickup refused, status readable. |

## 2. One prompt

The user pastes the prompt into any coding agent (Claude Code, Codex or another; desktop app or terminal) on the new PC and adds what they want, for example "a team that keeps our grant calendar, with a writer and a reviewer". Claude then does all of this in that turn:

1. **Checks** Node.js (18 or later) and git. It does not probe the hub itself: before enrolment the PC does not trust the hub's certificate, so an HTTPS probe would fail with a certificate error; `setup.mjs enrol` checks `GET /health` over the pinned CA instead, and stops on failure. If Node or git is missing, Claude **helps the user install it**: it detects the OS, gives the exact command or link (Windows: `winget install OpenJS.NodeJS.LTS` and `winget install Git.Git`; macOS: `brew install node git` or the installers from nodejs.org and git-scm.com; Linux: the distribution's package manager, for example `sudo apt install nodejs git`), offers to run the command once the user agrees, and re-checks. It never installs anything silently.
2. **Downloads** `setup.mjs` and `agent-hub-headers.mjs` from the hub (`GET /onboard/client/setup.mjs`, `/onboard/client/agent-hub-headers.mjs`) into `~/.config/conclave/`, and checks each SHA-256 against the prompt. A mismatch stops everything. These two files are public; the hash, not the transport, makes them safe, so they may come over plain HTTP. There is no separate skill to install.
3. **Enrols the PC.** Claude writes the enrolment code to `~/.config/conclave/onboarding/enrol-code` with its file tool (mode 600 on Linux and macOS), so the code never appears on a command line or in the process list, and runs **`node setup.mjs enrol --hub <url> --ca-sha256 <fp>`**. The script reads the code from that file (or from stdin), deletes the file once enrolment is confirmed, and refuses a `--code` argument. It swaps the code for the app key over pinned HTTPS and writes `AGENT_HUB_APP_KEY`, `AGENT_HUB_URL` and `AGENT_HUB_CA` straight into `keys.env`. It prints only variable names. If the PC is already enrolled with this hub, it skips enrolment and runs `check` instead (see [doctor](#doctor)).
4. **Drafts the request** from the user's words ([schema](#the-request)), asks only what is missing, shows a one-screen summary (project, team, roles, counts, folders), and after the user agrees writes it to a file and runs **`node setup.mjs request --file <path>`**, which files it.
5. **Asks the user how the agents' client should reach the hub** (setup builds the agents' folders for Claude Code), unless the PC already has a recorded choice: "Install and trust the hub certificate (HTTPS after the client restarts)" or "Use the LAN's plain HTTP (keys cross the network unencrypted at login)". It passes the answer to the script as `--transport https` or `--transport http`; with `https`, it shows the trust commands and runs them only after the user agrees. Setup itself always uses pinned HTTPS, whatever the answer (see [HTTPS](#https-without-os-trust)).
6. Runs **`node setup.mjs wait`** (see [how it waits](#3-the-script-waits-not-the-model)). On approval the script goes on by itself: pickup, `keys.env`, folders (with the chosen URL), login tests.
7. **Starts the coordinator** with a new session in the coordinator's folder (`start_session` with that folder in the desktop app; in a terminal, it tells the user to run `claude` there). This is allowed because it is the user's own turn.

Later requests use the same prompt: "add a team …" or "add two developers to <team>". The used code is ignored once the PC is enrolled.

Every step is **idempotent** and recorded in a state file, `~/.config/conclave/onboarding/state.json` (no secrets: request ID, pickup ID, enrolment nonce, steps done). If the user stops the turn, or closes the app, rerunning the same prompt resumes where it stopped.

### The request

`setup.mjs request` posts the request to `POST /onboard/requests`. The model writes it; it contains no secrets.

| Field | Type and limits | Notes |
|---|---|---|
| `kind` | `new_team` (default) or `add_agents`. | See [later requests](#later-requests-from-the-same-pc). |
| `project` | `{name, existing, kind?, more_teams?}`. `name`: 1–80 characters, `^[A-Za-z0-9][A-Za-z0-9 ._-]*$`. `existing`: boolean. `kind`: `implementation` or `research`. | With `existing: true` the name must match an existing project, case-insensitively; otherwise `invalid_argument` lists close matches. With `false` it must not match one. For `add_agents`, it must be the team's project. An existing project supplies its kind: `kind` may be left out, and a different one is refused. A new project asks for it; left out, it is `implementation` and the request carries the warning `project_kind_missing`. `more_teams` (boolean, default false, `new_team` only): more teams will join the project, so the team gets its own Blueprint part at approval; without it the only team of a project keeps its whole Blueprint at project level ([blueprint](blueprint.md) §3). The operator can change it at approval. |
| `team.name` | 1–80 characters, unique among teams that are not done or stopped. | For `add_agents`, give `team.id` instead. |
| `team.goal` | 1–4000 characters. | Becomes the team goal once approved. |
| `team.delivery_mode` | Ignored: every team acts when woken. Older connectors still send it. | |
| `team.close_on_approve` | boolean, default `true`. | |
| `team.coordinator_reviews` | boolean, default `false`. | |
| `team.lease_minutes` | 1–1440, default 30. | Same bounds as the team builder. |
| `team.stall_minutes` | 1–1440, optional. | |
| `team.max_review_rounds` | 1–20, default 3. | |
| `roles` | 1–8 entries (default limit; see below). | For `new_team`, exactly one has `team_role: "coordinator"` with `count: 1`. For `add_agents`, none does. |
| `roles[].name` | `^[a-z][a-z0-9_]{0,29}$`, unique in the request. | The playbook role name. |
| `roles[].team_role` | `coordinator`, `worker`, `reviewer` or `stakeholder`. | |
| `roles[].count` | 1–5. | At most 12 agents in total. |
| `roles[].job` | 1–500 characters, one line. | Shown to the operator; the agent's role detail once approved. |
| `roles[].reviews` | Role names, optional. | Each must exist in the request. A role may name itself only with `count` ≥ 2. The coordinator may appear only with `coordinator_reviews: true`. |
| `roles[].folders` | 0–10 `{path, access}`. `path`: absolute under `/vault/`, no `..`, no wildcards, at most 400 characters. `access`: `read` or `write`. | A proposal; the operator sets the real ceiling. `write` implies `read`. |
| `rules` | 0–20 entries, optional (default limit; see below). | Rules the agents should follow, as the filing agent found them: `setup.mjs schema` tells it to fill the list from the repo's `AGENTS.md` and `CLAUDE.md` files and the user's own instructions, one entry per rule. Each is a proposed directive; it becomes one only if the operator keeps it at approval ([directives from onboarding](directives.md#from-onboarding)). |
| `rules[].title` | 1–120 characters, one line. | The directive's title. |
| `rules[].source` | 1–200 characters, one line. | Where the rule comes from, for example `repo AGENTS.md` or `user instruction`. Kept as the directive's source. |
| `rules[].text` | 1–2000 characters. | The rule as written; the directive's text. |
| `rules[].category` | Optional: `access`, `communication`, `tokens`, `reporting`, `sources`, `process` or `tooling`. | The directive's category. |
| `rules[].role` | Optional: a team role (`coordinator`, `worker`, `reviewer`, `stakeholder`). For `new_team`, the team role of a role in the request. | The directive is then for that role of the team; without it, for the whole team. |
| `source` | `{from, ref?, note?}`, `new_team` only. Optional for older clients; left out, the request carries the warning `source_missing`. | Where the requirements or the research brief come from. `from`: `existing` (a source that exists: `ref` is required, a path or URL of 1–400 characters, one line), `coordinator` (the team's coordinator derives them) or `operator` (the operator supplies them). `note`: at most 500 characters. A `ref` is information for the team: it grants no permission to fetch or read it ([setup progress](#setup-progress)). |
| `requirements` | 0–30 entries, optional, `new_team` only (default limit; see below). | What the team should build, as the filing agent found it in the repo's specification and the user's words: functional (FR) and non-functional (NFR) requirements with their acceptance criteria. At approval they go into the team's Blueprint part as **one proposal** for the operator to review; they are never applied silently ([requirements from onboarding](#requirements-from-onboarding)). |
| `requirements[].kind` | `fr` or `nfr`. | |
| `requirements[].title` | 1–200 characters, one line. | The requirement's title. |
| `requirements[].text` | 1–2000 characters. | What it asks for; the item's body. |
| `requirements[].category` | For `nfr`, required: `perf`, `sec`, `rel`, `use` or `ops`. Not allowed for `fr`. | The NFR's key category (`NFR-SEC-nn`). |
| `requirements[].acs` | 0–10 entries, each 1–300 characters, one line. Optional. | Its acceptance criteria, one item each (`<key>/ACn`). |
| `requirements[].module` | Optional: an existing module of an existing project, 2–6 capitals. | Where the requirement goes. Left out: the team's new module. In a research project, required: a requirement sits in a module, never under a line. |
| `research` | `{lines, papers}`, optional, `new_team` only. | The research brief, typed. Lines need a research project (`project.kind: "research"`, or an existing research project); papers fit either kind. |
| `research.lines` | 0–10 of `{id, title, mode, question?, owner?, hypotheses?, questions?}`. | `id`: `^[a-z0-9][a-z0-9_-]{0,19}$`, unique in the request, for references. `title`: 1–200 characters, one line. `mode`: `validate` or `explore`. `question`: at most 2000 characters. `owner`: a role name in the request. |
| `research.lines[].hypotheses` | 0–10 of `{id, title, criteria?}`. | `id` as for lines, unique in the request. `title`: the statement, 1–200 characters, one line. `criteria`: at most 2000 characters, what would confirm or refute it. |
| `research.lines[].questions` | 0–10 of `{title, criteria?}`. | As for hypotheses, without `id`. |
| `research.papers` | 0–20 of `{title, status, venue?, type?, manuscript?, authors?, owner?, hypotheses?}`. | Existing **and** planned papers. `status`: `planned`, `drafting`, `submitted`, `accepted` or `published`. `type`: `paper`, `preprint`, `report` or `thesis`. `manuscript`: a path or URL, 1–400 characters, when there is one; a planned title needs none. `authors`: 0–20 names. `owner`: a role name in the request. `hypotheses`: ids of hypotheses in the request the paper is about. No claims: a paper's claims are the team's work. |
| `prompt` | 1–4000 characters. | The user's own words, kept for the operator. |
| `client` | `{app, os}`, each at most 40 characters. | Descriptive only. |

The per-request limits (8 roles, 12 agents, 5 per role, 20 rules, 30 requirements) are defaults; the requirements limit counts every typed record together (requirements, lines, hypotheses, questions and papers). They are defaults, editable in console **Settings → Onboarding** (`onboarding.max_roles`, `onboarding.max_agents`, `onboarding.max_per_role`, `onboarding.max_rules`, `onboarding.max_requirements`; `max_rules` and `max_requirements` may be 0, which refuses any); the hub validates against the current settings and names the limit in its error. At most 32 KiB of JSON. Validation runs in the hub and returns `invalid_argument` with the field path and the rule, up to 20 problems. The inbound key scan runs on every field: a secret in the request is refused and alerts.

<a id="warnings"></a>The hub also returns **warnings**, never errors, to the script and to the operator: a folder that does not exist in the vault (`folder_missing`); a `write` folder at the vault root or a top-level folder; a folder never granted to anyone; more than one worker role without a reviewer; a polling team on a client that cannot sustain the loop (`chatWarnings`); a goal that reads like a list of rules (`goal_has_rules`: two or more list lines, or three or more of "never", "always", "must", "do not", "don't"), which belong in `rules` so the goal stays a goal.

Amending (`PUT /onboard/requests/:id` with `version`) replaces the whole request while it is `submitted` or `needs_changes`; a stale `version` fails with `conflict`. Withdrawing (`POST /onboard/requests/:id/withdraw`) works in the same states.

### Later requests from the same PC

| Want | Request |
|---|---|
| A new team in a new project | `kind: "new_team"`, `project.existing: false`. |
| A new team in an existing project | `kind: "new_team"`, `project.existing: true`. |
| More agents in an existing team | `kind: "add_agents"`, `team: {id}`. The team must have been created by an earlier `collected` request from this PC (looked up in `onboarding_requests`); otherwise `denied` with the generic message. The team keeps its own settings. Each role names an existing team role or a new one; a new one gets the default playbook for its team role. |
| One agent with no team, for a person's shared notes | `kind: "vault_agent"`: see [A vault agent](#a-vault-agent). |

Agent names continue the team's numbering (`Echo developer 3` after `Echo developer 2`). Variable names are unique on the PC.

### Recruits from a coordinator

A recruit's key reaches its PC the same way: through a [key handover](#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc) that the PC's user allows on the connector's screen. No key is ever returned to the coordinator, to the operator or to any chat, so a key cannot leak through a conversation (feedback `fb_sde3hhmnsgpia`).

When a coordinator calls `team_recruit` in a team set to **Automatic**, or the operator approves a recruit request in a team set to **Ask me**, the hub, in one transaction:

1. creates the agent, with its recruiting coordinator's owner ([agent owners](authorization.md#agent-owners)), `recruited_team_id` and `recruited_by`, its role and the purpose as its role description;
2. files an onboarding request for **the coordinator's PC**, of kind `add_agents`, already `approved` (the recruit envelope the operator set for the team is the approval), with one slot: the recruit's label, a session variable `<PROJECT>_<TEAM>_<LABEL>_SESSION_KEY` and a folder unique on that PC, the recruit's rules as the slot's ceiling (the same rules as before: a read-only copy of the coordinator's standing access, or the team's recruit template), and the binding to that PC.

No key and no membership exist yet. The coordinator's PC is the PC of the app key the coordinator's `team_recruit` call came through; for an operator's approval, the PC the coordinator's key is bound to, else the PC of its latest login. That PC needs an app key with the onboarding capability (a PC set up with **Add PC**); otherwise the recruit is refused with `invalid_state` and nothing is created.

The tool result (and the operator's approval) names the PC, the request and the folder, and says that **the PC's user allows the new agent on the connector's screen**: no command is run. The request is a key handover of kind `recruit`, so the connector sees it at its next check-in and lists it on its screen. After the click it picks the key up, writes it into its key file, builds the folder beside the team's other agents (under the root of the request that set up the team) and confirms. The recruit joins the team at confirm, and the coordinator gets the usual `team_joined` notice. The session key expires after the team's `recruit_days`, counted from pickup. A recruit not picked up within 24 hours is cancelled like any handover.

What stays the same: recruits count against `recruit_max` from the moment they are created, also while they wait for pickup; switching recruiting off, or ending the team, revokes the recruits' keys and cancels their waiting pickups (the waiting agents are archived). The operator sees a waiting recruit in the PC's onboarding requests, as an approved request, with **Cancel** and **Reissue pickup**. A recruit's request is not checked against "created by an earlier request from this PC": the recruit envelope already limits it. While it waits, it is the PC's pending request, so the PC files nothing else until it is picked up or cancelled.

### A vault agent

A person who shares vault folders ([folder grants](multi-user.md)) can have one agent of their own that reads and revises notes in those folders, with no project, team, task board or Blueprint.

The request takes only `kind: "vault_agent"`, `agent: {name, job}` (name 1–60 characters, job one line), `folders` (1–10 `{path, access}` under `/vault/`), `prompt` and `client`. Any other field, a team or roles among them, is refused, by the hub and by `setup.mjs` before filing. The folders are a proposal, like a team's.

The approval needs an **owner**: a member (not an administrator) the agent works for. The operator may rename the agent, edit its job and its folders. Each folder must lie inside one of the owner's folder grants and be visible to the owner (a restricted folder never is); `write` needs a Contribute grant. Where the owner's grants nest, the most specific one that covers the folder decides: with Read on `/Shared/` and Contribute on `/Shared/Team/`, a write to `/Shared/Team/` is approved and delegated on that inner grant, and a write to `/Shared/` is refused. Otherwise the approval names every folder that does not fit and creates nothing. Approve then, in one transaction:
- adds the folders to the delegation of the owner's grants that hold them (Contribute only where the folder asks for `write`), so the owner sees them under **Shared folders** as delegated to agents;
- creates the agent with no project, owned by the owner, with the role `vault_agent` and the job as its role detail;
- writes one slot whose ceiling is the folder rules for those folders plus the directive, session and feedback tools: no task, team, message or Blueprint tool;
- moves the request to `approved` with no team, and issues no key.

Every agent file the hub writes (CLAUDE.md, and Codex's AGENTS.override.md) ends its **Connection** section with the same two lines for both clients: the `conclave` server connects the agent through the Conclave connector and is logged in for it (never call `session_login`, never read the connector's key file, never put a key or token anywhere), and if the conclave tools are missing it stops and reports the client's exact error and the output of `conclave check` in that folder. The text is `connectionLines()` in `server/src/onboarding/onboarding.ts`; a test pins it.

Pickup issues the one key and a short **CLAUDE.md** for a teamless agent: who it works for, its job and folders; read a note with `file_read`, then revise it with `file_update` and the `base_revision` it read, and on a conflict read again and merge; create with `file_create`; never delete, rename or restore; and when a folder is refused, its access was withdrawn, so it stops and tells the person. It has no `work_next` and never polls. Confirm joins no team; `team_id` stays empty.

Only directives scoped to the whole hub (or to the agent itself) reach it: it has no project, team or role, so a project's or team's directives never do.

**Revocation.** The agent is bounded twice: by its key's ceiling (the approved folders) and, while [owner enforcement](authorization.md) is on, by its owner's current folder grants. Removing the owner's grant, or lowering it to Read, refuses the agent's next edit at once. While owner enforcement is off, only the key's ceiling applies: revoke or narrow the agent's key to stop it. Cancelling an approved request archives the agent; the delegation stays on the owner's grant until the operator edits it.

### Trust

Everything in the request is **L2 data** written by a model on an unverified PC: a proposal for the operator, never an instruction to the hub, the operator or any agent.
- The console renders every request field as inert text (no HTML, Markdown or links), labelled "Written by the agent on <PC>".
- The approval screen leads with what the hub computed from the structured fields (agents, roles, folders, the access each would get), and shows the free text (`goal`, `job`, `prompt`) beneath it, `prompt` collapsed.
- Request text enters no playbook, directive, requirement or rule automatically. Once the operator approves, the goal and role jobs become operator-approved team text (L0 for the agents), so the operator sees and can edit them first. Rules become directives only when ticked; requirements reach the Blueprint only as a proposal the operator reviews.

## States

| State | Meaning | Who moves it on |
|---|---|---|
| `submitted` | Waiting for the approval. | Operator: approve, ask for changes, deny. Script: amend, withdraw. |
| `needs_changes` | The operator asked for changes, with a note. | Script: amend (back to `submitted`), withdraw. Operator: deny. |
| `approved` | Project, team and agents exist; keys wait for pickup. | Script: pickup and confirm. Operator: reissue, cancel. |
| `collected` | Pickup confirmed. Terminal (a [Re-enrol PC](#later) reopens a pickup on it). | |
| `denied`, `withdrawn`, `cancelled` | Terminal. | |

**Pending** means `submitted`, `needs_changes` or `approved`. Nothing pending expires: a request and an uncollected pickup stay open until the operator acts or the script withdraws the request. The console keeps each one in view with its age: a Home attention item ("Team request from <PC> waiting for you · 3 days", "Keys approved, not collected yet · 2 days"), the PC's page and the Team requests band in the Teams card on Home.

## One approval

One console screen, **Onboarding request**, reached from the Home attention item and the PC's page, shows the project, the team and every agent together. It replaces the two approvals of the earlier draft.

The operator can edit anything before deciding:
- project, team name, goal and settings;
- roles, counts and jobs (the coordinator row cannot be dropped for a new team);
- per agent: the **permission ceiling** (a permission template, prefilled with one generated from the role's requested folders, or an existing template; a `write` on the vault root needs a second confirmation), and the **PC binding** switch (prefilled "Use only from <PC>", see [binding](#pc-binding-of-session-keys));
- for a new team, the **standard directives**, "Who decides" and "What stays with the operator", from the hub template ([directives from onboarding](directives.md#from-onboarding)): hub text, not L2, editable for this team, always created;
- the **rules** the agent proposes, in their own section under the computed agents: each shown as L2 text ("Written by the agent on <PC>"), with its source, category and whether it is for the team or one role. Every rule starts unticked, so agent-written text never becomes a directive by default: the operator ticks each rule to adopt it, and can then edit its title and text. A ticked rule becomes a directive at approval; an unticked one is dropped.
- the **requirements** the agent proposes, in their own section: each shown as L2 text with its kind, editable title and text, and its acceptance criteria. Each starts ticked, since it still goes to the Blueprint as a proposal; unticking one leaves it out of that proposal.
- the **source** of the requirements or brief (an existing source and its reference, the coordinator, or the operator), and the **research records**: lines with their mode, hypotheses and questions, and papers with their status, manuscript and owner. Each is L2 text, each line and paper starts ticked, and unticking one leaves it out (`edits.research` is the kept list). Records that cannot go in, such as lines in an implementation project or a requirement without a module in a research project, are named with the field and the fix before the approval is accepted.

A new team **starts automatically** once it is approved and setup completes; there is no separate Start step.

Edits are recorded as a diff in the request history and returned to the script with the status. The screen warns when an edit breaks the plan: a role named in another role's `reviews` is dropped, or a worker role is left without a reviewer.

Then:
- **Approve**, in one transaction: creates the project (if new), the team as `draft` with the approved settings (for `add_agents`: adds any new role playbooks, nothing else), its role playbooks with each job as role detail, and each agent (project, role, role detail, `role_source='admin'`); writes one `onboarding_slots` row per agent with its team role, `session_var`, folder, binding and ceiling (template ID plus a snapshot of its rules). Each rule the operator kept becomes a directive, scoped to the team (or to `<team id>|<role>` when the rule names a role), with its source and category, the tag `onboarding`, and marked reviewed by this approval; the console sends the ticked list as `edits.rules`, and without it no rule is adopted. For a new team it also creates the two standard directives (the operator's wording from `edits.standard`, else the template), sets a new project's kind from `project.kind`, and, when requirements or research records are kept, files them as **one** Blueprint proposal linked to the request (`edits.requirements` and `edits.research` are the kept lists; without them, everything filed). The request's version, the limits, the references and the current grants are checked again inside this transaction, so a request changed, a limit lowered or a template removed since the screen loaded fails the approval and creates nothing. No session key, permission rule or team membership exists yet. The request moves to `approved`.
- **Ask for changes:** a note (at most 500 characters); the request moves to `needs_changes`.
- **Deny:** an optional note; the request moves to `denied`. Nothing was created, so nothing is left behind.
- **Cancel** (after approval, before collection): revokes any unconfirmed keys, archives the request's agents, closes the slots and, for a new team, stops the draft team.

### Requirements from onboarding

<a id="content-from-onboarding"></a>Everything typed that the operator kept goes into **one Blueprint proposal**, linked to the request (`proposal_id`), and the approval lists each item with its intended scope: **team** (inside the team's part) or **project** (a module of the project outside the part).

The kept requirements become **one Blueprint proposal** in the new team's part, filed by the approval in the same transaction, for the operator to apply or reject in the Blueprint like any other ([proposals](blueprint.md)):
- each FR is keyed `FR-<module>-nn` under the team's new module, numbered in the order filed; each NFR `NFR-<CAT>-nn`, numbered after the project's highest; each acceptance criterion `<key>/ACn` under its requirement;
- every item is `draft`, with the title and text as the operator left them;
- the proposal has no agent behind it: its reason names the onboarding request, and it waits in the project's proposals with the usual `bp_proposal` alert.

A project's only team has no part ([blueprint](blueprint.md) §3, FR-PLAN-12): what would go in its module or line goes at project level instead, in a module (a line, in a research project) named after the team with no `team_id`, which the same proposal opens first, so applying it opens that module or line and files the records in one step; the items show scope **project**.

Nothing is applied silently: until the operator applies the proposal, the team's part holds only its module (or line), and a project's only team has nothing in the Blueprint yet.

Requirements go into a module: the team's new one, or the module named in `requirements[].module` (scope project when another team or the project owns it). A research project's new team gets a line, not a module, so a requirement there must name an existing module of the project; it is never put under a line. Without one, the approval names the requirement and the fix: untick it, name a module, or change the project.

Research records go into the team's line:
- each line becomes a line inside the team's line (`L3.1`, `L3.2`, …) with its mode and question, `active`;
- each hypothesis `H-<line>-nn` (`untested`, its statement and criteria), each question `Q-<line>-nn` (`open`);
- each paper `PAP-n` at project level, owned by the team, with its status, venue, type, manuscript and authors. A planned paper needs only a title. A paper's hypotheses are kept on the request and shown in the setup record; once the Blueprint has the `studies` relation (`paper → hypothesis`), the proposal also links each paper to them.

The owner of a line or paper (a role in the request) is shown with it in the setup record. The research coordinator keeps the papers current through the team's playbook and standard directive, like the rest of its part.

When nothing typed was kept (for example the only answer is "the operator will supply them"), no proposal is filed, never an empty one, and the setup record shows who owes the content.

### Setup progress

The request is the setup record. Its **setup** view, on the request and on the team's page in the console, is derived from the answers, the proposal's status and what the team's part holds, never stored:

| State | Who | Next step |
|---|---|---|
| Source not asked (the onboarding client did not ask: an older client left `source` out) | The operator | Set where the requirements or the brief come from. |
| `existing`, nothing kept | The coordinator | Read the source at its reference with the access the team has, and propose the requirements or brief with `bp_write`. |
| `coordinator`, nothing kept | The coordinator | Derive the requirements or brief from the goal and propose them with `bp_write`. |
| `operator`, nothing kept | The operator | Supply the requirements or brief. |
| Proposal open | The operator | Review the proposal in the Blueprint. |
| Proposal applied | Nobody | Done: the team plans from its part. |
| Proposal rejected, stale or withdrawn | Back to the named person (the operator for `operator`, else the coordinator) | Correct the content and propose again. |
| No proposal linked, and the part already holds content | Nobody | Done: the team plans from its part (n items). |

A rejected or stale proposal also notifies the team's coordinators, as for any team proposal.

**The part already holds content.** A team set up before the setup proposal existed has no proposal, so the card would never finish. With no proposal linked, the card reads Done as soon as the team's part holds live content beyond its own track: a live, non-archived item inside the module or line the team owns (other than that track item), or owned by the team and not a module or line. For a project's only team, which has no part (FR-PLAN-12), live project-level items count instead. Dropped and cut items do not count. The hub computes the count; a team right after approval, holding only its track item, is not Done. With a proposal linked, the proposal's status decides, as above.

**Setting the source on the card.** The operator can set or correct the source from the setup details (below), or on the Setup card where the team has no Blueprint to show (**Set the source**: the same three choices and checks as the request's `source`), in every state except while a proposal is in review. `PUT /api/onboarding/:id/source {source}` (admin) takes an approved or collected `new_team` request; any other request is refused with `invalid_state`, as is an open proposal. The answer is stored beside the approved request (`source_set`, migration 0136), never inside it: the approved body stays the record of what the operator approved, and the setup view reads `source_set` first. Each set is audited as `onboarding.source_set` with the old and new values. Only the operator sets it, because it is the operator's answer; a coordinator that needs it asks with `team_ask`. When the new state gives the coordinators work (an existing source, or the coordinator derives it), the team's coordinators get one `setup_source` notice: "The operator set where your requirements come from: … Next: …". Nothing is sent for `operator`, or when the card reads Done. The reference stays information: it grants no access.

**The setup is one row on the Blueprint card.** The team page gives the setup no card of its own: it is one row on the team's Blueprint card, after Coverage, reading `Setup · <state> · <the source, in short>` (Source not asked and Coordinator derives stand alone), with the full source in its tooltip. The value takes the state's tone; Done is plain. The row opens the setup details in a sheet: the state, the source, who, next, the proposal and what it filed, the note that a source reference grants no access, and **Set the source** in every state except while a proposal is in review. When the next step is the operator's (Source not asked, Waiting for you, or Returned to the operator), the operator's Needs you lists "Setup: <next step>" (kind `setup`, scoped to the team), which opens the sheet; its episode is the setup's state, so the row leaves by itself when the state changes. A proposal in review is already there as the proposal. A team with no Blueprint to show (no project yet, or one that could not be read) keeps the card in every state.

Why keys and members wait: `team_members.credential_id` is `NOT NULL`, `insertMember` (through `pickCredential`) refuses an agent with no active session key, and standing rules live on the key's policy (`setRules(credential.policy_id, …)`). So:

| When | What happens |
|---|---|
| Approve | Agents and slots, as above. |
| Pickup (each issue) | Per slot: `createSessionKey` with no expiry, the slot's ceiling applied to its policy, the binding set. A reissue revokes the previous unconfirmed keys first. No team membership. |
| Confirm (one transaction) | Each agent joins the team with its confirmed key (`insertMember`). A new team starts. Agents for a running team (`add_agents`) join here. |

Approval does not reuse `recruit_requests` (its `requested_by` is `NOT NULL REFERENCES agents`, and no status fits a pickup slot). The other way round, a [recruit](#recruits-from-a-coordinator) reuses onboarding's pickup: its request and slot are created by the recruit path, not by this approval, and only a recruit's agent has `recruited_team_id`, so switching recruiting off never revokes agents onboarded by a request the operator approved.

## 3. The script waits, not the model

`node setup.mjs wait` is one long-running command. It long-polls `GET /onboard/requests/:id?wait_s=45` in a loop inside the script, so waiting costs no model tokens, and prints one line only when the state changes ("Waiting for the administrator · filed 10 min ago"; "Changes asked: <note>"; "Approved"). On approval it continues by itself:

1. **Collision check** before pickup: the status lists each agent's `session_var` and folder (no secrets). If a variable already exists in `keys.env` (without `--replace`) or a folder already belongs to another variable, it stops without calling pickup, so no issue is used.
2. **Pickup and confirm** ([endpoints](#endpoints)): the hub creates the session keys now; the script writes each secret straight into `keys.env` (a temporary file in the same folder, then a rename, keeping all other lines; mode 600 on Linux and macOS), then confirms.
3. **Folders**, for each agent in `<root>/<project>/<folder>` (default root: the folder the user ran the prompt in):
   - `.agent-hub.json`: `{"session_var": "<var>"}`;
   - `.mcp.json`: the `agent-hub` server with the hub URL and the headers helper, with the folder as its argument (on Windows `node "<profile>/.config/conclave/agent-hub-headers.mjs" "<folder>"`), as in [MCP setup](mcp.md#claude-desktop-sessions-over-ssh). Compact replies suit long-running polling agents, not everyone, and are a per-folder choice made there, not on the key: add `"headers": {"X-Agent-Hub-Compact": "1"}` to the server entry, and every reply's text is its structured JSON alone, with each task text sent once per login ([Replies and notices](mcp.md#replies-and-notices));
   - `.claude/settings.local.json`: `{"enabledMcpjsonServers": ["agent-hub"]}`;
   - `CLAUDE.md` from the agent's `instructions` (built by the hub from the approved playbook; no secrets);
   - `git init` and `*` in `.git/info/exclude`;
   - workspace trust: `projects["<folder>"].hasTrustDialogAccepted` in `~/.claude.json`, after one backup of that file per run.
4. **A login test per folder**: runs the helper as Claude Code would and reports `ok` or the helper's own one-line error.
5. Prints only variable names, folder paths, test results and the coordinator's folder; exit code 0 only when every test passed.

The command needs no model attention while it waits, but it runs inside a Claude Code turn, and a foreground command there has a time limit: 2 minutes by default, at most 10 minutes when the command is given a longer timeout (Claude Code today). If the tool's limit killed `wait`, the model would see a timeout rather than the script's own line and would likely rerun it, the loop this design rules out. So `wait` ends by itself well inside the limit: by default after 1 minute of waiting (`--max-minutes`, leaving time for pickup, folders and login tests), and the prompt runs it with `--max-minutes 9` and a 600000 ms timeout. So:
- If the approval comes within the wait, the script finishes, and Claude starts the coordinator in **the same user turn**.
- Otherwise the script exits cleanly with "Still waiting for approval; rerun the prompt (or say 'continue') once it is approved", and the state file keeps the request. Claude ends the turn with that line. The next user turn reruns the same command and resumes. Claude never loops or re-polls on its own.
- Claude may run `wait` in the background instead, so the user can keep working. When it ends, the app resumes Claude, but that is not a user turn: starting the coordinator may then need the user to click a session card (see [blockers](#starting-the-team)).

For `add_agents`, the script reports the new folders; Claude tells the user that the coordinator will see them in its team notices, instead of starting a coordinator.

## Endpoints

Plain HTTPS on the hub, outside `/mcp` and the admin API. `Cache-Control: no-store`. Off loopback, plain HTTP is refused with `426`, except the two public downloads.

| Call | Auth | Result |
|---|---|---|
| `GET /onboard/client/setup.mjs`, `GET /onboard/client/agent-hub-headers.mjs`, `GET /onboard/ca.crt` | None (public files) | The script, the helper, the hub's CA certificate. Also served on the LAN plain-HTTP port, since their hashes are checked. |
| `POST /onboard/enrol {code, nonce}` / `POST /onboard/enrol/confirm {nonce}` | The enrolment code | The app key secret, hub URL, PC name. See [the enrolment code](#the-enrolment-code). The code may come in the `X-Conclave-Enrol-Code` header instead of the body (the [checkout](checkout.md) restore client sends it so); hub logs redact the header. |
| `POST /onboard/requests`, `PUT /onboard/requests/:id`, `POST /onboard/requests/:id/withdraw` | App key with the capability | File, amend, withdraw. `{request_id, version, state, warnings}`. |
| `GET /onboard/requests/:id?wait_s=0..45`, `GET /onboard/requests?pending=1` | App key (its own requests) | `{request_id, state, version, operator_note, edits, project, team_id, filed_at, waiting_since, agents}`; `agents` from `approved` on: `[{label, role, session_var, folder}]`, no secrets. Returns early on a change. A checkout request adds `checkout` (agents, render choices, handout bodies and hashes, config scans; [checkout §6](checkout.md#6-restore-by-the-connector)). |
| `POST /onboard/requests/:id/scan {folders: [{folder, findings: [{kind, path, detail}]}]}` | The app key that filed the checkout request | The restore's config scan, before pickup. Returns `{scans}`. Counts against the pickup limit. Pickup is refused with `scan_pending` until every agent folder is scanned and none waits for the operator; confirm then answers `trust: {folder: bool}`. |
| `POST /onboard/pickup {request_id}` | The app key that filed the request, with the capability | Creates the session keys and returns `{pickup_id, hub_url, team: {id, name}, agents: [{agent_id, label, role, team_role, session_var, folder, secret, instructions}]}`. `session_var` is `<PROJECT>_<TEAM>_<ROLE>[_<n>]_SESSION_KEY`, upper-cased, non-alphanumerics as `_`, unique among the PC's keys. |
| `POST /onboard/key-pickup {code}` | An app key | **Refused** (`invalid_state`): key prompts and collections were replaced by the [key handover](#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc), picked up with `POST /onboard/pickup`. |
| `POST /onboard/pickup/confirm {pickup_id, written: [session_var…]}` | Same | Adds the agents to the team, moves the request to `collected`, starts a new team. Also records the MCP transport the user chose (`transport: "https" | "http"`, see [HTTPS](#https-without-os-trust)). `written` must list every slot. |

The earlier draft's MCP tools (`project_request`, `project_request_status`, `project_request_withdraw`) are dropped: the session that runs the prompt has no hub connection yet, and the script does all hub calls itself.

### One-time pickup, retries and a lost response

- **Secrets are created at pickup, not stored.** The hub keeps only verifiers. Approval stores slots, not secrets or keys.
- **Before confirmation, a retry reissues.** A second `pickup` before `confirm` creates fresh keys and revokes the previous unconfirmed ones; no team member points at an unconfirmed key. `confirm` accepts only the latest `pickup_id`.
- **At most 3 issues before confirmation.** The fourth is refused and alerts; the operator checks the PC and presses **Reissue pickup**, which allows 3 more and revokes any unconfirmed set.
- **After confirmation, never again.** `pickup` on a `collected` request returns `invalid_state` and raises `onboarding_pickup_after_collect` (warning). Only [Re-enrol PC](#later) reopens one.
- **A lost confirm.** The script writes `keys.env` before confirming and keeps the `pickup_id` (not a secret) in the state file; rerun, it only repeats `confirm`.
- **Bound to the PC:** only the app key that filed the request can pick up and confirm.
- **A lost approval response.** The approval records the version it was made against. Sending the same approval again (`version` unchanged) after the request moved on returns the original result, with the same team and proposal and `replayed: true`, and creates nothing; a different `version` gets the usual `invalid_state` or `conflict`.

## PC binding of session keys

Migration 0025, the login check, `PUT /api/keys/:id/binding` and the switch on the key's overview in Keys implement it; rotation keeps the binding. The approval screen has a per-agent "Only from <PC>" switch, on by default for onboarded agents.

**Every session key has a binding switch** in Keys: "Use only from <PC>" or "Free (any permitted PC)". It is a general key feature, not only for onboarding.

| Rule | Value |
|---|---|
| Storage | `credentials.bound_machine_id`, null when free. |
| Defaults | Onboarded keys: bound to the PC that collected them. Keys made with **New session key** on a PC's page: bound to that PC, with **Free** as the other choice on the form. Keys created by hand in Keys: free. |
| Where it is set | Per agent on the approval screen (prefilled bound); at creation, `POST /api/keys {kind: "session_key", …, machine_id}` (the PC page sends it), bound in the same transaction so the key is never free in between and audited as `key.binding_set` with `source: "create"`; any time in Keys on the key's row (`PUT /api/keys/:id/binding {machine_id}`; `{machine_id: null}` makes it free). Changing it is audited (`key.binding_set`) and takes effect at the next login. |
| Effect | `session_login`, and header login, with a bound key succeed only through an app key whose PC is the bound one. Elsewhere it fails as an invalid key (the caller learns nothing more), raises `bound_key_elsewhere` (warning, with both PCs) and is audited. Existing sessions are not ended by binding; the operator ends them in Keys if needed. |
| What it protects | A **session key leaked without its PC key** (pasted into a chat, a log, a share) cannot be used from any other PC. It does **not** stop a thief who holds the PC's app key: the binding is satisfied by that app key, and the session keys sit in the same `keys.env`. |

Bound by default whenever the hub knows the PC: a key made from a PC's own page starts bound to it. A separate `PUT /binding` after create was not chosen, because the key would be free between the two calls.

## Key handover: a rotated key or a recruit reaches a connector PC

A session key never travels through a chat, a prompt or the console when its PC runs the connector. The hub makes a **key handover** for that PC, the PC's user allows it on the connector's screen, and the connector picks the keys up, writes them into its key file and confirms. It is the same pickup an onboarding request uses (`POST /onboard/pickup` and its confirm), so it survives a crash the same way. It replaces the key pickup codes (`setup.mjs key`) and the Codex wake's collection: those routes refuse from this release on, and their tables (`key_pickups`, `key_collections`, `key_collect_polls`) are no longer read or written; they are dropped one release later. Server code: `server/src/keys/handover.ts`, with the pickup in `server/src/onboarding/onboarding.ts`. Connector code: `deploy/client/connector/handover.mjs`. Tests: `server/test/key-handover.test.ts` and `deploy/client/connector-handover.test.mjs`.

| Rule | Value |
|---|---|
| What it is | An onboarding request the hub files itself (`handover` set on the row): `rotate` (new secrets for existing session keys; the request's kind is `rotate`) or `recruit` (new agents from `team_recruit`; kind `add_agents`). One slot per key or agent. It is born `approved`: the operator's Rotate, or the team's recruit envelope, is the approval. It is never an onboarding request anyone can act on: the operator's request queue leaves it out, and approve, deny, needs-changes, amend, withdraw and the PC's `GET /onboard/requests/:id` answer `not_found` for it. |
| Bound to | One PC and one app key: the app key the PC's connector last checked in with (`connector_reports`). There is no other fallback: a PC with no connector report gets the show-once path, because no connector there could ever allow the handover. Only that app key can list, pick up or confirm it. When that app key is rotated or replaced (after a leak, below, or at Re-enrol), its open handovers move to the new key, and the old one is refused for them. A woken run or a turn token cannot reach these routes, because they need the app key. |
| Which PC | For a rotation, the key's PC as the key prompt found it: the binding, else the PC of the last login, else the PC that collected it. A key whose PC has no connector report, or is retired, is shown once instead (the raw key, the one fallback; audited as `key.rotate` with `delivery: "shown"`). For a recruit, the coordinator's PC, as before. |
| Signal | The check-in answer carries `handovers` (the number open for this app key) and the push stream sends `event: handovers`. Neither carries a secret. `GET /connector/v1/handovers` (app key) lists `{id, kind, description, agents: [{agent_id, label, key_id}], expires_at}`: plain descriptions and, for a rotation, the public id of the key being replaced (`ah_ses_<key_id>`, never the secret), so the connector finds the agent that holds it. Under a lockdown of all writes or of this PC the list answers `423 lockdown`, as the pickup does; the connector keeps its clicks and staged keys and tries again after the lift. A connector that holds no key with that id reports it with `POST /connector/v1/handovers/:id/skip {reason: "key_not_held"}`, and the hub cancels the handover at once (`not_on_pc`), so the console says so instead of waiting 24 hours. A recruit whose folder the connector refuses (below) is reported the same way (`folder_refused`). |
| The click | The connector asks the PC's user first, on both the standard and the hardened level: the screen lists the hub's description, shown as the hub's words ("New key for Coordinator (rotation)", "2 new agents for team X"), with **Allow**. The click is bound to that handover's id. It covers that handover until it is confirmed, so a crash before confirm does not ask again, and it is spent at confirm or when the handover is cancelled or expires. A new Rotate is a new handover and asks again. Without the click nothing is picked up. |
| Pickup | `POST /onboard/pickup {request_id}` with that app key. Refused for another app key or PC (`not_found`), after 24 hours (`invalid_state`, expired), and once confirmed. For a rotation the answer holds each key's new secret once; the hub keeps only its verifier on the slot, and **the old key keeps working**. A second pickup before confirm replaces the staged secrets, so a key picked up and lost never works. For a recruit the agents' keys are made as for any onboarding pickup. |
| On the PC | The connector saves the list first (no secrets), then writes the keys (through the key service on a hardened PC), never into a log, the environment or a chat. **A rotated key is staged:** the new secret goes beside the old one, as a `staged` entry under the same label, and the old key stays the one in use. Only when confirm answers 200 does the connector swap them; when confirm is refused for good (a 4xx such as expired, cancelled or replaced, carrying the hub's own code `invalid_state`, `not_found` or `conflict`), it discards the staged secret and the old key goes on working. Any other answer (401, 408, 429, a 5xx, a relay's 502, or a bare 404 or 409 without the hub's code) counts as no answer: the hub may already have swapped and revoked the old key, so the staged secret is kept and confirmed again at the next run. After a restart a staged entry is confirmed again, then swapped or discarded. A recruit's keys are staged the same way, so a refused confirm leaves no key behind. A recruit's folder name and its team's name come from the hub, so the connector builds the folder only inside the team's root on this PC (beside the team's other agents, else under the root of the request that set the team up here, else the default root), as a real path, under the same name rules as transfers: no `..`, no reserved name, and no folder below the root that is a link or junction. Anything else is refused and reported (`folder_refused`), and no key is kept. The folder is registered, so the hub sees it as a proposed folder for the operator to approve. |
| Confirm | `POST /onboard/pickup/confirm {pickup_id, written}`. For a rotation, only now is each old key revoked, with its logins and turn tokens ended, and the new key takes over its rules, grants and team places (the usual `key.rotate`, `delivery: "handover"`). For a recruit, the agents join the team. Confirm is idempotent per `pickup_id`: a second confirm after a lost answer answers 200 with the same result (`already: true`), so the connector keeps the new key. A crash between pickup and confirm leaves the old key working: the connector confirms when it already wrote the keys, and picks up again when it did not. |
| After a possible leak | A rotation with the answer "Yes, or I'm not sure" (`reason: suspected_leak`) on a connector PC also **replaces that PC's connector app key**, because whoever took the session key may hold it too. Only that app key is revoked (`pc.app_key_replaced`, with the old and new key and the codes revoked); the PC's other app keys and the other agents' session keys stay. **The suspected session key is held at once** (`key.hold`; the console shows it as **Held: leak rotation**): it is suspended with the reason `leak_hold`, so its logins and turn tokens end and none is given again, through any PC's app key, so a free key (`bound: false`) used from another PC is refused too. This costs nothing, because the agent's PC is offline until it is paired again anyway. Holding the key does not cancel its handover (an operator's suspend does, below). Replacing the app key, filing the handover and holding the key are one transaction: if the handover cannot be filed, nothing is replaced. A new app key and its pairing code are issued, and the rotate answer carries the code once (`pairing: {code, code_expires_at, ca_check, hub_origin, pc}`). The handover is bound to the new key; the old app key cannot list, pick up or confirm it. Revoking the old app key ends every session and turn token issued through it, so **until the PC user pairs the connector again, no agent on that PC can reach the hub**; the other agents' session keys stay valid and work again once the connector is paired. `conclave pair` with the new code replaces the app key in the same section of the PC's key file (same hub, same CA), so the agents' keys and the folder approvals on the PC stay: pairing again loses nothing. The handover waits, with the usual 24-hour expiry, until the new app key picks it up; its confirm makes the new secret the agent's key and revokes the held one. |
| Expiry and cancel | A handover not confirmed within **24 hours** is cancelled (nothing changes on the hub; for a recruit, the waiting agent is archived as when recruiting is switched off). The console shows an open handover as **Waiting for the PC user** on the key's Overview and in Needs you, with **Cancel**; the operator can also rotate again, which replaces it. Revoking, suspending or re-binding the key cancels it too, and so does the connector's skip report; holding it for a leak rotation does not. **A leak rotation that ends without confirm** (expired, cancelled, skipped) leaves the old key held, never live again by itself: the key's page and Needs you say **Leak rotation not finished: rotate again or revoke**. Rotating again starts a new handover for the held key. **Resume** is refused for a held key, because it may have leaked: it comes back only as a new key (rotate) or not at all (revoke). |
| Audit | `key.handover.created`, `key.handover.picked_up`, `key.handover.confirmed` and `key.handover.cancelled` (with the reason: `operator`, `expired`, `replaced`, `revoked`, `binding_changed`, `not_on_pc`, `folder_refused`, and `rotation_reason: suspected_leak` when it was a leak rotation), each with the PC and the agents, never a secret. A leak rotation adds `pc.app_key_replaced` and `key.hold`; a Re-enrol handover on a PC that holds none of the keys adds `pc.re_enrol_keys_lost`. |

**In the console.** **Rotate secret** keeps its question "Could this key have leaked?". When the key's PC runs the connector, the action is **Rotate and send to <PC>**: the result is a status card on the key's Overview ("Waiting for the PC user to allow it on <PC>", with Cancel), which turns green at confirm. After a possible leak the sheet says that the connector's app key on that PC is replaced too, that the key is held at once, and that until the PC user pairs the connector again no agent on that PC can reach the hub; the result then shows the new pairing code once, with the `conclave pair` command for that PC. A key with no connector PC gets **Rotate and show the key once**: the raw key, shown once, with the existing one-time view, and the console says that the key then has to be put on its PC by hand (`setup.mjs key` is refused). A handover the PC reported as not held there shows "Not on <PC>: this PC does not hold the key", with Rotate again. **New session key** on a PC's page works the same way: the new key reaches the PC by handover.

**Never into a repository.** No step writes a key into a file inside a repository. Keys live in the connector's key file, outside version control.

## HTTPS without OS trust

The script **pins the CA fingerprint from the prompt** for all its own calls: it fetches `/onboard/ca.crt`, checks its SHA-256 against the prompt, and uses it as the only trusted root for the hub. So enrolment and pickup always run over HTTPS, and `426` on plain HTTP stays. Nothing is added to the operating system for this.

What each step may use on the LAN profile ([lan.Caddyfile](../deploy/caddy/lan.Caddyfile)), and why it is safe:

| Step | Transport | Why it is safe |
|---|---|---|
| Downloads: `/onboard/client/*` (setup script, helper, prompt template, manifest) | Plain HTTP or HTTPS. Caddy's plain-HTTP site proxies these paths only. | The files are public, and the script checks each against the SHA-256 in the prompt, which the operator copied from the console over HTTPS. A changed byte stops setup. |
| `/onboard/ca.crt` | Plain HTTP or HTTPS (same matcher). | The certificate is public, and the script checks its fingerprint against the prompt before using it. A swapped certificate fails that check, so it is never trusted. |
| Enrolment (`/onboard/enrol`, `/enrol/confirm`) and requests (`/onboard/requests*`) | HTTPS only, with the CA pinned. Plain HTTP gets Caddy's 308 to HTTPS, and the hub answers `426` if it is reached on plain HTTP anyway. | The enrolment code and the PC key travel here. The pinned CA means a machine in the middle cannot present its own certificate. |
| Pickup (`/onboard/pickup`, `/pickup/confirm`) | HTTPS only, with the CA pinned (as enrolment). | Session keys travel here, once; the same pinning and `426` apply. |

For Claude Code's own MCP connection, **Claude asks the user**, before the folders are built:
- **Install and trust the hub certificate:** in the Windows user store (`certutil -user -addstore Root`, which shows a Windows confirmation), plus `NODE_EXTRA_CA_CERTS` (or `NODE_USE_SYSTEM_CA=1` where the Node version supports it) in the user's environment. The folders use the HTTPS URL, which works after the Claude Code app restarts.
- **Run over the LAN's plain HTTP:** the folders use the plain-HTTP URL. The script shows the warning, "This PC talks to the hub over plain HTTP; keys cross the network unencrypted at login," and the coordinator repeats it in its first message.

The choice is recorded in the state file and reported at confirm, so the console shows the PC's transport (a plain-HTTP PC is marked on the PCs page). Either way the user can switch later with the doctor: `setup.mjs check --https` (rewrites the folders' URLs; `setup.mjs trust` gives the trust commands) or `setup.mjs check --http --lan-url <url>`.

## Doctor

`node setup.mjs check` diagnoses a PC. It changes one thing only: trust in `~/.claude.json` for an onboarded folder that lost it (a Claude Code session that was open during setup can save its own copy of the file over the script's), re-applied after one backup and reported as `trust <VAR>: re-applied`. `--https` and `--http` also switch the transport. The prompt runs it first whenever the PC is already enrolled.

| Check | Reports |
|---|---|
| Hub | `/health` reachable on the pinned URL; plain HTTP or HTTPS. |
| Trust | The pinned CA matches; whether Claude Code trusts it (Windows store, `NODE_EXTRA_CA_CERTS`). |
| Tools | Node version, `git` on the path. |
| Keys | `AGENT_HUB_APP_KEY`, `AGENT_HUB_URL`, `AGENT_HUB_CA` and each folder's `session_var` present in `keys.env` (present or missing, never the value). |
| Config | `~/.config/conclave/` and `~/.claude.json` writable. |
| Folders | For each folder in the state file: `.mcp.json`, git repository, trust flag, a login test with the helper's own result (`ok`, `invalid_key`, `revoked`, `bound to another PC`…), and the last `helper.log` line for that folder. |

One line per check (`ok` or `fail <check>: <reason>`), exit code 0 only when all pass. Claude reports the failing lines and the [recovery](#blockers-and-recovery).

## Blockers and recovery

Where onboarding can get stuck, and how this design removes or handles each case. Claude reports the script's line or the hub's error as it is, then the recovery; it never guesses a cause it did not see.

### Before the request (new PC)

| Case | What the user sees | How this design handles it | Who acts |
|---|---|---|---|
| **Skill and script not installed** | — | **Removed.** Nothing is installed by hand: the prompt downloads `setup.mjs` and the helper from the hub and checks their hashes. | — |
| **PC key not in `keys.env`** | — | **Removed.** The prompt carries a single-use code; `setup.mjs enrol` writes the app key into `keys.env`. No long-lived key is copied, pasted or seen by the model. If the code was used elsewhere: "This enrolment code was already used" and an `enrolment_code_reused` alert; the operator presses **Re-enrol PC**. | Operator if reused |
| **No route to the hub** | "Can't reach the hub at <url>." | Checked first (`/health`); nothing is filed until it answers. Check the network, VPN, and that the URL in the prompt is the one the certificate was issued for. | User; operator if the hub is down |
| **HTTPS not trusted** | — for setup; a plain-HTTP warning for MCP. | **Removed for setup:** the script pins the CA from the prompt, so enrolment and pickup use HTTPS without OS trust. For Claude Code's MCP, Claude asks the user: install and trust the certificate (HTTPS after an app restart), or plain HTTP on the LAN with a warning; the choice is recorded and the doctor switches it later. | User chooses |
| **No Node or git** | "Node.js 18 or later is needed" / "git is needed," with the exact command for this OS. | Checked first. Claude guides the install: the command or link for the detected OS (for example `winget` on Windows), run only after the user agrees, then a re-check. Never a silent install. If the new tools are not on the path in this session, the user opens a new session and reruns the prompt; it resumes. | User agrees; Claude runs |
| **Config not writable** (corporate PCs) | "Can't write `~/.claude.json`" or `~/.config/conclave/`. | Found by the first checks or by `enrol`, before anything is filed. Ask IT for write access; for trust alone, open `claude` once in each agent folder and accept the dialog by hand, then rerun. Another config location is not supported. | User, IT |

### The request

| Case | What the user sees | How this design handles it | Who acts |
|---|---|---|---|
| **A second request while one is pending** | "This PC already has a pending request: <team>, filed <time>, waiting for <step>." | The prompt reads the pending request first (`GET /onboard/requests?pending=1`) and offers to wait, amend (while `submitted` or `needs_changes`) or withdraw it. After approval only the operator can cancel. | User; operator to cancel |
| **Over the limits** | The field and the rule ("13 agents, at most 12"). | `invalid_argument` with the field path. Claude proposes a smaller team, or a second request (`add_agents`) once the first is collected. | User |
| **Vault folders that do not exist** | A warning per folder. | `folder_missing` warning, to the script and the operator. Claude asks whether it is a typo or a folder to create; the operator may grant it anyway. | User; operator decides |
| **Project name clash** | "A project <name> already exists. Did you mean it?" | `invalid_argument` with close matches; use the existing project or another name. | User |
| **The model misreads the prompt** | The summary does not match what the user meant. | Nothing is filed without the user's yes to the one-screen summary. After filing, amend while `submitted` or `needs_changes`. The operator also sees the user's own words. | User |

### The approval

| Case | What the user sees | How this design handles it | Who acts |
|---|---|---|---|
| **The operator is away** | "Waiting for the administrator · filed 3 days ago." | **Simpler with one approval:** one wait, not two. Nothing expires; Home shows the request with its age, oldest first. The script exits after its wait and the next prompt run resumes; the user may contact the operator outside Conclave. | Operator |
| **`needs_changes` with an unclear note** | The operator's note, word for word, labelled as theirs. | Claude explains what it may mean, marked as its reading, and proposes an amendment for the user to confirm; if still unclear, the user asks the operator. | User, operator |
| **Operator edits that conflict with the plan** | The edits as a list, with conflicts called out ("The reviewer role was removed; the developer's work has no reviewer"). | The approval screen warns the operator about such edits before approving. The coordinator's `CLAUDE.md` is built from the approved playbooks, never from the request, so it matches the edits. If the user cannot work with them, they ask the operator, who edits the team page or cancels. | Operator; user |

### Pickup and setup

| Case | What the user sees | How this design handles it | Who acts |
|---|---|---|---|
| **Lost response or crash** | The script's error, then success on rerun. | Every step is idempotent with a state file; see [retries](#one-time-pickup-retries-and-a-lost-response). After 3 issues the operator presses **Reissue pickup**. | User; operator after 3 |
| **Variable or folder clash** | "`<VAR>` already exists in keys.env" / "`<folder>` belongs to `<other VAR>`." | Checked **before** pickup, so no issue is used. `--replace` when the old entry is the same agent and dead; otherwise another root folder. A clash with a different agent's variable is an operator rename. | User; operator to rename |
| **The helper never runs** (git and trust) | The agent's session has no hub tools; `helper.log` has no `start` line. | The script always does `git init` and trust. Claude Code runs a project headers helper only in a git repository; a Claude Code update may change that. The script's login test runs the helper directly, so `check` also reads `helper.log` after the first session starts and reports "Claude Code did not run the helper in <folder>", pointing to the [MCP troubleshooting table](mcp.md#claude-desktop-sessions-over-ssh). The acceptance checks rerun on each Claude Code release the teams use. | User; developer on a Claude Code change |
| **Login test fails behind a misleading OAuth error** | The client says `unable to get local issuer certificate` or `Stopped an OAuth request …`. | The script and `check` print the helper's own error line and the last `helper.log` line, never the client's; the OAuth text is a symptom of a failed header login. | User |
| **No write access to `~/.claude.json` or the config folder** | As above. | Found before anything is filed (see the first table). | User, IT |

### Starting the team

| Case | What the user sees | How this design handles it | Who acts |
|---|---|---|---|
| **Starting a session in another folder is refused** | A session card instead of a running session. | Claude starts the coordinator in the user's own turn (when the wait ended there, or on the rerun turn), which is allowed. After a background wait, or for the other members, the app may show a card per session for the user to click; the coordinator proposes one card per member. | User clicks |
| **A session opened in the wrong folder** | That session has no hub tools. | The script starts sessions with the exact folder; each agent's `CLAUDE.md` says to stop and report if `agent-hub` tools are missing, and the coordinator's member list names each absolute folder. | User |
| **Usage limits stop sessions mid-task** | A usage-limit message. | Hub state is kept; started work passes its check-in time, is flagged overdue and stays with its holder. Resume after the reset; the coordinator picks up from `task_list`. The operator can lengthen `lease_minutes` or `stall_minutes`. | User; operator for settings |

### Later

| Case | What the user sees | How this design handles it | Who acts |
|---|---|---|---|
| **Adding agents from another PC** | `denied`. | `add_agents` works only from the PC that onboarded the team. Run the prompt there, or the operator adds agents in the console from that PC's page, and each key reaches the PC by [key handover](#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc). | User or operator |
| **Agent folders moved** | New agents' folders are not next to the old ones. | Same PC, so the prompt works; the script takes the current folder as root. `check` reports folders from the state file that no longer exist; moved ones need their `.mcp.json` helper argument and trust entry updated as in [MCP setup](mcp.md). | User |
| **A rotated or revoked key leaves a dead folder** | No hub tools, so nothing in the session says why. | For a key the hub knows but that is revoked, suspended, expired or bound to another PC, the helper prints that reason (the caller already holds the key, so this reveals nothing new); unknown keys stay generic. `check` shows it per folder. The operator rotates the key (or presses Make a new prompt) and pastes the key prompt on the PC, which writes the new key into the same variable; or re-enrols the PC. | Operator, then user |
| **PC replaced, reinstalled or lost** | Keys and folders gone; pickup says already collected. | **Re-enrol PC** issues a new code and prompt and revokes the PC's old app keys at once. With the connector, the agents' keys are handed over once the PC is paired again; a connector that holds none of them reports it, and the hub then revokes them and reopens the PC's collected requests for a fresh pickup. Without the connector, the session keys are revoked at once and the next pickup reissues fresh keys. Running the new prompt enrols, picks up, rebuilds the folders and starts the coordinators. For a lost PC whose keys must stop at once, the operator also revokes them in Keys. | Operator, then user |
| **A hub upgrade does not start** (for example a database the 1.0 runner does not recognise, or an applied migration that changed) | "Can't reach the hub." | `/health` fails, so nothing is filed or collected. Nothing pending is lost. The operator fixes the deployment (the stop message in the log says what to do). If the upgrade changed `setup.mjs`, an old prompt's hash no longer matches: the operator copies a fresh prompt (Re-enrol PC if the code was never used; an enrolled PC updates the script itself over pinned HTTPS). | Operator |

## Admin API

| Route | Purpose |
|---|---|
| `POST /api/pcs/add {name}` | Add PC: PC, app key with the capability, enrolment code; returns the prompt text. The code appears only in this response. |
| `POST /api/pcs/:id/re-enrol` | New code, prompt and app key; revokes the PC's old app keys and any unused code at once. With a connector report, answers `handover` (the handover that carries every agent key; the old keys work until confirm). Without one, revokes the onboarded session keys and reopens a pickup on each of the PC's collected requests (`reopened`). |
| `GET` / `PUT /api/settings/onboarding` | The per-request limits (roles, agents, per role, rules, requirements) and the filing rate limits; defaults 8, 12, 5, 20, 30, and 5 an hour, 20 a day per PC key. |
| `DELETE /api/pcs/:id/enrolment` | Revoke an unused code. |
| `GET /api/onboarding?status=` · `GET /api/onboarding/:id` | List; one request with its versions, computed access, warnings and history. |
| `POST /api/onboarding/:id/approve {version, edits?, agents: [{slot, include, template_id, bound}]}` | The one approval. `edits` may carry `rules` (the ticked rules), `requirements` (the kept requirements), `research` (the kept lines and papers) and, for a new team, `standard` (the wording of the two standard directives, `[{key, title, text}]` with `key` `who_decides` or `operator_only`). Onboarded session keys have no expiry. A new team starts when setup completes. A [vault agent](#a-vault-agent) request also needs `owner_id`, and its `edits` may carry `team.name` (the agent's name) and `roles[0]` (job and folders). |
| `POST /api/onboarding/:id/needs-changes {note}` · `/deny {note?}` · `/cancel {note?}` · `/reissue-pickup` | As above. |
| `PUT /api/keys/:id/onboarding` · `DELETE /api/keys/:id/onboarding` | Capability on or off. |
| `PUT /api/keys/:id/binding {machine_id}` | Bind a session key to a PC, or `null` for free. For any session key. |
| `POST /api/keys {kind: "session_key", …, machine_id?}` | Create a session key bound to that PC from the start (the PC page's **New session key**); omitted or null: free. An unknown PC is refused before a new agent is made. |

A [checkout](checkout.md) restore is an onboarding request of kind `checkout`, picked up and confirmed on the same `/onboard` routes. The request is approved at render, because the target PC is already enrolled. Its keys are successors: the old key is suspended at confirm, and the moved agent's first call, `checkout_resume`, is accepted only from a login of the new key made after confirm.

## Audit, alerts and notices

| Event | Audit | Alert |
|---|---|---|
| PC added, re-enrolled, code revoked; enrolment used; app key replaced after a leak | `pc.add`, `pc.re_enrol`, `pc.re_enrol_keys_lost`, `pc.app_key_replaced`, `onboarding.code_revoke`, `onboarding.enrol` | `enrolment_code_reused` (warning); `enrol_fail` burst (warning) |
| Capability on or off | `onboarding.capability_grant`, `…_remove` | |
| Request filed, amended, withdrawn; second refused | `onboarding.request_file`, `…_amend`, `…_withdraw`, `…_refused_pending` | `onboarding_request` (info, a Home item while it waits; it closes by itself once the request is approved, sent back, denied, withdrawn or cancelled, and opens again when a request that was sent back is amended) |
| Approved (edit summary, agent IDs, templates, bindings), changes asked, denied, cancelled | `onboarding.approve`, `…_needs_changes`, `…_deny`, `…_cancel` | |
| A recruit filed for pickup on the coordinator's PC | `agent.recruit` (with the request), `onboarding.recruit_file` | `agent_recruited` (info) |
| Pickup issued, confirmed (with the chosen transport), reissued, reopened by re-enrol | `onboarding.pickup_issue` (issue number), `…_confirm`, `…_reissue`, `…_reopen` | `onboarding_pickup_retry` (warning) on the 3rd issue |
| Pickup refused (after collect, wrong key, failed auth) | `onboarding.pickup_refused` | `onboarding_pickup_after_collect` (warning); failed-auth burst as for logins |
| Key prompt: a key picked up; a pickup code refused | `key.pickup`; `key.pickup_refused` | failed-auth burst as for pickup |
| Binding changed; bound key used elsewhere | `key.binding_set`; `auth.bound_key_elsewhere` | `bound_key_elsewhere` (warning) |
| Request refused by the key scan | `onboarding.request_refused` | `credential_leak` as today |
| An unknown session key retried from one place | the sign-in records (`authentication_events`) | `unknown_session_key` (warning), see below |

### Unknown session key

An agent whose folder holds a stale or mistyped key keeps retrying its login, and the hub refuses each one the same way
as any wrong key. When one session key id that the hub cannot match (outcome `unknown` or `invalid`; a bound key used
elsewhere has its own alert) is refused **3 times within 10 minutes from one source**, the hub raises
`unknown_session_key`. A single typo raises nothing. The count is a sliding window over the sign-in records, by source
and key id; the thresholds are `alerts.unknownKeyMax` and `alerts.unknownKeyWindowMs` in the config.

The alert has one row per PC and key id (subject `<pc>/<key id>`; later refusals bump its repeat count). It names the
PC behind the app key, the teams whose active keys are bound to that PC, and the folder and variable name that the
headers helper reported. The helpers send the folder (`X-Agent-Hub-Folder`, URI-encoded) and the variable name
(`X-Agent-Hub-Session-Var`) with their own sign-in calls, never a key, and the hub keeps them only for this alert,
trimmed to plain text. The console says "this agent's key is not recognised" and asks the operator to collect the
agent's keys again on that PC.

### Setup checks

`setup.mjs` keeps the **key id** of each variable it writes into keys.env (pickup and `key`), never the value.
`node setup.mjs check` compares, for each folder, the variable its `.agent-hub.json` names, the key id keys.env holds
for it and the id setup wrote, by key id only. A mismatch names the variable and the folder. The folder line shows the
key id, and a failed login test shows it too, to compare with the agent's key in the console.

Audit details hold IDs, states, counts and field names, never request free text or secrets. There are no agent notices before pickup; the script learns everything from the status. After pickup, the coordinator's first login carries the usual team notices.

## Threat model

| Threat | Controls | Remaining exposure |
|---|---|---|
| **Installer and updates:** the hub, or someone in the middle, serves a tampered connector; a downgrade to a weak version; a lost signing key. | The installer and every update are signed by a release key that is not on the hub, and checked against a key the connector carries, independently of the hub, for signer, version and platform. Downgrades the hub asks for are refused. Rollback goes only to the previous verified build on the PC. Key rollover is signed by the old key. The maintainer approves each version; the PC user can turn updates off. A private git, when the user accepts it, is a pinned version checked against the hash in the connector's signed release. | Whoever holds the release key can ship code to every PC that updates. Flaws in that git version until the next connector release. |
| **Pairing:** a code read from a chat or a log; a second hub with the same CA; a CA swapped in later. | The code appears only in the console and on the local pairing screen, never in a prompt, chat, argument or log. It lasts 30 minutes and is bound to the hub's identity, origin and CA pin. A changed CA or origin needs the PC user's local confirmation. A web pairing screen listens on loopback only, with a one-time token and an origin check. | Someone at the user's screen during those 30 minutes. |
| **The prompt leaks** (a transcript, a chat, a screen share) | It holds no long-lived secret: a single-use code, public hashes, a public fingerprint. The code is a secret until used: the model and the transcript see it, so single use is what limits it. It never goes on a command line (the script reads it from a file or stdin, so the process list does not show it). Once used, the code is worthless; reuse is refused and alerts. | An **unused** Add PC code has no timer, so a leaked prompt that was never run lets its holder enrol as that PC. A checkout's code expires after 30 minutes. The real run then fails with `enrolment_code_reused`, and the console shows unused codes with their age; the operator revokes unused codes and re-enrols. |
| **Stolen PC key** (from `keys.env` or a backup) | The capability allows only filing, status and pickup. One pending request per key; every request needs the operator's approval with the PC name and its history on screen. The operator can turn the capability off, or suspend or revoke the key, at any time. Pickup after collection alerts. | A thief can file requests while the capability is on (each reaches the operator) and can collect an approved request's keys before the real script, which then fails and alerts. **PC binding does not help here**: the thief holds the PC's app key, which satisfies it, and the session keys sit in the same `keys.env`. Turn the capability off on PCs that no longer need it. |
| **A session key leaked without its PC key** | Bound keys (the default for onboarded keys) fail from any other PC, alert and are audited. The inbound key scan refuses keys pasted into hub content. | A free key works from any permitted PC, as today. |
| **Replayed or intercepted pickup** | Keys are created at pickup and never stored. A retry revokes the previous unconfirmed set. Confirm accepts only the latest `pickup_id`; after confirm, pickup is refused and alerts. Pinned HTTPS for every script call; `426` on plain HTTP; `no-store`. | An attacker who holds the PC key and wins the race to confirm gets the keys; the real script then fails with an alert. |
| **A tampered setup script** | The prompt carries the script's and helper's SHA-256; Claude checks them before running anything. Later updates come over pinned HTTPS. | A tampered prompt (hashes and fingerprint replaced) defeats this; the prompt must come from the console to the user directly. |
| **A request that asks for too much** | Fixed schema with bounds; at most 12 agents by default (Settings); no wildcards; folders are a proposal. The operator sets each ceiling from a template. Warnings for broad writes. Nothing is created before approval, and no access exists before pickup. | An operator can approve too much; the computed access summary is there to prevent it. |
| **Request text as prompt injection to the operator** | All request text is L2, rendered inert, labelled with its source, under the computed summary. Nothing flows into a playbook, directive or rule without the operator approving it. The console never passes request text to a model. | The operator reads persuasive text written by a model. The computed access summary is the defence. |
| **Request text as injection to the team** | Goal and jobs become L0 only after approval, editable in place. A goal that reads like rules is flagged (`goal_has_rules`). | As for any operator-written goal. |
| **A source reference as a fetch instruction** | `source.ref` and `manuscript` are text for the team, shown inert. The hub never fetches them, and they grant no folder, repo or network access: the team reads a source only with access the operator granted separately. | A team may follow a link it was given; its own access rules apply. |
| **Proposed requirements as injection to the plan** | Requirements in a request are L2 text: shown inert and editable at approval, then filed as one Blueprint proposal of `draft` items that the operator applies or rejects; never applied by the approval itself. Bounds on count and length; the key scan covers them. | The operator may apply a proposal without reading every item; drafts stay editable, and agreeing them is a separate step. |
| **Proposed rules as injection to the team** | A rule in a request is L2 text and never reaches an agent by itself: it becomes a directive (L0) only if the operator ticks it at approval (every rule starts unticked), after reading it inert, labelled as written by the agent, with its source, and editable in place. Bounds on count and length; the inbound key scan covers the rules too; every created directive carries the tag `onboarding` and is audited. | The operator may tick a persuasive rule without reading it closely; it can be edited or retired in Work → Directives like any other. |
| **A rotated key on its way to the PC** | A key whose PC runs the connector gets no prompt and no pickup code: it reaches the PC by [key handover](#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc), picked up only with that PC's app key after the PC user's click, and the old key is revoked only at confirm. A key with no connector PC is shown raw, once, in the console, with the warning not to paste it into a chat. After a possible leak the PC's connector app key is replaced too and the suspected key is held at once. | A raw key shown once and then leaked works until it is revoked or rotated as a possible leak (bind it to a PC to narrow it). Whoever holds the PC's current app key and can click on its screen can take a handover. |
| **Secrets reaching the model** | Enrolment and pickup are a script that prints only names; the prompt carries no key. The one secret the model sees is the enrolment code, until it is used (row above). | A shell-capable model can read `keys.env`, as today ([threat model](threat-model.md)). |
| **Plain-HTTP MCP by the user's choice** | Claude asks before building the folders; a visible warning; the console marks the PC; `check --https` switches over. | On a PC that chose plain HTTP, the app key and session keys cross the LAN in clear at each header login; anyone on that network can capture them (a bound key still works through that PC's app key, which also crosses). |
| **Trusting the hub certificate** | Only by the user's choice; the fingerprint from the prompt is checked first. | The PC then trusts Caddy's root for every name, so whoever gets the hub's CA key can impersonate any site to that PC. |
| **Keys with no expiry** (the PC key and onboarded session keys) | Revocation in Keys; a leak rotation, which replaces the connector's app key too; and Re-enrol PC, which revokes the PC's app keys and any unused code at once and replaces its session keys (by handover with the connector); PC binding by default; alerts on misuse. | A leaked key works until the operator revokes it. |
| **Flooding** | Per-key and per-address rate limits; one pending request per key; size bounds. | |

## Moving existing PCs to the connector

A PC set up before the connector keeps working while the hub serves both clients. `conclave check` stays read-only: it names an unmoved folder (`old_layout`) and says to run `conclave migrate`, which does the cutover. The user moves the PC with `conclave migrate` (plan by default, then `--apply`, `--rollback`, `--finish`), described in [connector](connector.md#moving-an-old-pc-conclave-migrate). Nothing on the hub changes: the same agents, keys and PC are used, so no data is reset. A PC that chose plain HTTP moves only to the pinned HTTPS address and CA the user gives. A legacy CA or environment setting is removed only with evidence that setup wrote it, and only when the user asks. The move removes the old pieces it replaces (setup, the headers helper, the Codex bridge and wake, the old key file), saving each first so `--rollback` restores them until `--finish`. There is no compatibility with the old bridge version: a PC removes it before installing the connector, or runs this one command. The release after removes the old client from the repository.
