#!/usr/bin/env python3
"""Claude Code headersHelper for Conclave: log in outside the model and hand Claude Code ready headers.

Claude Code runs this at every connection and again after the hub answers 401 (for example when the session token
expired). It prints {"Authorization": "Bearer <app key>", "X-Agent-Hub-Session": "<session token>"}, so the agent never
calls session_login and neither the key nor the token appears in its transcript.

Configuration, all outside the model:
  .agent-hub.json in the agent's folder, no secrets. Pass the folder as the first argument
  (agent-hub-headers.py /path/to/agent); without it the working folder is used. Contents:
      {"url": "http://127.0.0.1:8080/mcp", "session_var": "ECHO_LEAD_SESSION_KEY"}
      optional "keys_file" (default ~/.config/conclave/keys.env) and "app_var" (default AGENT_HUB_APP_KEY)
  keys file (mode 600): AGENT_HUB_APP_KEY=ah_app_… and the session key variable named above.
      Optional AGENT_HUB_URL=… pins the hub: it wins over the folder's "url", which must then match or be left out,
      so a cloned repository's .agent-hub.json cannot send the keys elsewhere.
A valid cached token is reused; otherwise the helper logs in once and caches the new token (mode 600).
One Claude session per folder: each folder is one agent.
"""
import http.client, json, os, stat, sys, urllib.error, urllib.parse, urllib.request

HOME = os.path.expanduser('~')
TIMEOUT = 4  # Claude Code gives the helper 10 s in total


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # the hub never redirects /mcp; following one would forward the app key elsewhere


OPENER = urllib.request.build_opener(NoRedirect)


def fail(msg: str) -> None:
    print(f'agent-hub-headers: {" ".join(str(msg).split())}', file=sys.stderr)  # always one line
    sys.exit(1)


def read_env(path: str) -> dict:
    try:
        st = os.stat(path)
    except OSError:
        fail(f'keys file not found: {path}')
    # Windows reports mode bits that never pass this test; NTFS ACLs protect the file there.
    if os.name != 'nt' and st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        fail(f'{path} must be readable by you only (chmod 600)')
    out = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    out[k.strip()] = v.strip()
    except (OSError, ValueError) as e:
        fail(f'cannot read {path}: {e}')
    return out


def call(url: str, headers: dict, name: str, args: dict) -> tuple:
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}}).encode()
    try:
        req = urllib.request.Request(url, data=body, method='POST', headers={'content-type': 'application/json', 'accept': 'application/json, text/event-stream', **headers})
        with OPENER.open(req, timeout=TIMEOUT) as r:
            status, raw = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, {}
    # URLError, timeouts and socket errors are OSErrors; a dropped connection can also be an HTTPException.
    except (OSError, http.client.HTTPException, ValueError) as e:
        reason = getattr(e, 'reason', None) or e
        fail(f'{name}: request to {url} failed: {str(reason) or type(reason).__name__}')
    try:
        if raw.lstrip().startswith('{'):
            msg = json.loads(raw)
        else:
            events = [l[5:] for l in raw.splitlines() if l.startswith('data:')]
            if not events:
                fail(f'{name}: the hub sent an empty reply (HTTP {status})')
            msg = json.loads(events[-1])
    except ValueError:
        fail(f'{name}: the hub sent a reply that is not JSON (HTTP {status})')
    result = msg.get('result') if isinstance(msg, dict) else None
    data = result.get('structuredContent') if isinstance(result, dict) else None
    return status, data if isinstance(data, dict) else {}


def main() -> None:
    # The agent's folder: the first argument if given (Claude Code does not always run the helper in the folder that
    # declares the server), else the working folder.
    folder = os.path.abspath(os.path.expanduser(sys.argv[1]) if len(sys.argv) > 1 else '.')
    try:
        with open(os.path.join(folder, '.agent-hub.json'), encoding='utf-8') as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        fail(f'cannot read .agent-hub.json in {folder}: {e}')
    if not isinstance(cfg, dict):
        fail('.agent-hub.json must be a JSON object')
    var = cfg.get('session_var')
    if not var:
        fail('.agent-hub.json needs "session_var"')
    keys = read_env(os.path.expanduser(cfg.get('keys_file', f'{HOME}/.config/conclave/keys.env')))
    # The working folder may be an untrusted clone: a hub URL pinned in the keys file wins, and a folder URL
    # that disagrees with it is refused rather than silently ignored.
    url, pinned = cfg.get('url'), keys.get('AGENT_HUB_URL')
    if pinned:
        if url and url.rstrip('/') != pinned.rstrip('/'):
            fail(f'.agent-hub.json url {url} differs from AGENT_HUB_URL in the keys file; refusing to send keys there')
        url = pinned
    if not url:
        fail('.agent-hub.json needs "url" (or set AGENT_HUB_URL in the keys file)')
    if urllib.parse.urlsplit(url).scheme not in ('http', 'https'):
        fail(f'hub URL must be http(s): {url}')
    app_key, ses_key = keys.get(cfg.get('app_var', 'AGENT_HUB_APP_KEY')), keys.get(var)
    if not app_key or not ses_key:
        fail(f'the keys file lacks the app key or {var}')
    # The folder and the variable name (never a key) go with the helper's own calls, so an alert about a refused key
    # can say which folder to fix.
    auth = {'Authorization': f'Bearer {app_key}', 'X-Agent-Hub-Folder': urllib.parse.quote(folder, safe=''), 'X-Agent-Hub-Session-Var': var}
    cache_dir = f'{HOME}/.config/conclave/tokens'
    cache = f'{cache_dir}/{var}.tok'
    token = None
    try:
        with open(cache, encoding='utf-8') as f:
            token = f.read().strip() or None
    except (OSError, ValueError):
        pass
    # Reuse the cached token while the hub still accepts it; a refused one means a fresh login.
    if token:
        status, data = call(url, {**auth, 'X-Agent-Hub-Session': token}, 'session_whoami', {})
        if status != 200 or data.get('error'):
            token = None
    if not token:
        status, data = call(url, auth, 'session_login', {'session_key': ses_key})
        token = data.get('session_token')
        if status != 200 or not isinstance(token, str) or not token:
            fail(f'login refused ({status}): {data.get("error") or "no token"} {data.get("message", "")}'.strip())
        try:
            os.makedirs(cache_dir, mode=0o700, exist_ok=True)
            fd = os.open(cache, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as f:
                f.write(token)
        except OSError as e:  # still usable this time; the next run logs in again
            print(f'agent-hub-headers: cannot cache the session token: {e}', file=sys.stderr)
    print(json.dumps({'Authorization': f'Bearer {app_key}', 'X-Agent-Hub-Session': token}))


if __name__ == '__main__':
    main()
