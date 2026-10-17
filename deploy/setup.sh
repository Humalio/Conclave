#!/usr/bin/env bash
# Set up and start Agent Hub with Docker: choose a vault, choose how it is reached, get an admin login.
#
#   deploy/setup.sh                                   # asks for anything not given
#   deploy/setup.sh --vault ~/Notes --mode local
#   deploy/setup.sh --demo --mode lan --host 192.168.1.20
#   deploy/setup.sh --vault /srv/notes --mode domain --host hub.example.com --email you@example.com
#
# Modes
#   local   This machine only: http://localhost:8080. No certificates.
#   lan     Other machines on your network: everything on https://HOST:8443 with an internal
#           certificate. Plain http://HOST:8080 also carries MCP and bridge traffic, unencrypted.
#   domain  A public DNS name pointing here: everything on https://DOMAIN with Let's Encrypt.
#
# Writes .env (refuses to replace one unless --force), creates ./data, builds and starts the
# containers, waits for /health, prints the address and the generated admin password once, and
# then removes the password from .env.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

vault="" demo=0 mode="" host="" email="" admin="admin" force=0 start=1 assume_yes=0
http_port="" https_port=""

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
die() { echo "setup: $*" >&2; exit 1; }
ask() { # ask VAR "Prompt" [default]
  local __var=$1 __prompt=$2 __def=${3:-} __val
  if [[ $assume_yes -eq 1 ]]; then printf -v "$__var" '%s' "$__def"; return; fi
  read -r -p "$__prompt${__def:+ [$__def]}: " __val || true
  printf -v "$__var" '%s' "${__val:-$__def}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault) vault=${2:?}; shift 2 ;;
    --demo) demo=1; shift ;;
    --mode) mode=${2:?}; shift 2 ;;
    --host) host=${2:?}; shift 2 ;;
    --email) email=${2:?}; shift 2 ;;
    --admin) admin=${2:?}; shift 2 ;;
    --http-port) http_port=${2:?}; shift 2 ;;
    --https-port) https_port=${2:?}; shift 2 ;;
    --force) force=1; shift ;;
    --no-start) start=0; shift ;;
    -y|--yes) assume_yes=1; shift ;;
    -h|--help) usage ;;
    *) echo "setup: unknown option $1" >&2; usage 1 ;;
  esac
done

command -v docker >/dev/null || die "Docker is required (https://docs.docker.com/engine/install/)."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (the 'docker compose' command)."
[[ -e .env && $force -eq 0 ]] && die ".env already exists. Start it with 'docker compose up -d --build', or rerun with --force to replace it."

# ── vault ──────────────────────────────────────────────────────────────────────────────────────
if [[ -z $vault && $demo -eq 0 ]]; then
  ask vault "Vault folder (an Obsidian vault works; leave empty to start with a copy of the demo vault)" ""
  [[ -z $vault ]] && demo=1
fi
if [[ $demo -eq 1 ]]; then
  vault="$root/vault"
  if [[ -e $vault ]]; then echo "Using the existing ./vault (not overwritten)."
  else cp -r demo/vault "$vault"; echo "Copied the demo vault to ./vault."; fi
fi
vault="${vault/#\~/$HOME}"
[[ -d $vault ]] || die "vault folder not found: $vault"
vault="$(cd "$vault" && pwd)"
[[ -w $vault ]] || echo "Note: $vault is not writable by $(id -un); agents will only be able to read it."

# ── mode and address ───────────────────────────────────────────────────────────────────────────
[[ -z $mode ]] && ask mode "Who should reach the hub: local (this machine), lan (your network, HTTPS), domain (public name, HTTPS)" "local"
case "$mode" in
  local)
    public_url="http://localhost:8080" ;;
  lan)
    if [[ -z $host ]]; then
      guess="$( (hostname -I 2>/dev/null || true) | awk '{print $1}')"
      ask host "IP address or LAN name clients will use" "$guess"
    fi
    [[ -n $host ]] || die "lan mode needs --host"
    http_port=${http_port:-8080}; https_port=${https_port:-8443}
    public_url="http://$host:$http_port" ;;
  domain)
    [[ -z $host ]] && ask host "Public domain name (its DNS must point at this machine)" ""
    [[ -z $email ]] && ask email "Email for Let's Encrypt notices" ""
    [[ -n $host && -n $email ]] || die "domain mode needs --host and --email"
    http_port=${http_port:-80}; https_port=${https_port:-443}
    public_url="https://$host" ;;
  *) die "mode must be local, lan or domain" ;;
esac

# ── secrets and .env ───────────────────────────────────────────────────────────────────────────
rand() { if command -v openssl >/dev/null; then openssl rand -hex "$1"; else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi; }
pepper="$(rand 32)"
password="$(rand 18)"
# ./data holds the database and blobs: owner only. The umask below comes too late for it, and an
# existing ./data from an earlier setup is tightened as well.
mkdir -p -m 700 data
chmod 700 data 2>/dev/null || echo "Note: could not restrict ./data to its owner (chmod 700); check who owns it."
umask 077
# --force: start from a new file. Writing over the old one would keep its mode, possibly world-readable.
rm -f .env
{
  echo "# Written by deploy/setup.sh on $(date -u +%Y-%m-%dT%H:%MZ). See .env.example for every setting."
  echo "VAULT_HOST_DIR=$vault"
  echo "VAULT_ALIAS=vault"
  echo "KEY_PEPPER=$pepper"
  echo "ADMIN_USERNAME=$admin"
  echo "ADMIN_PASSWORD=$password"
  echo "PUBLIC_URL=$public_url"
  echo "HUB_UID=$(id -u)"
  echo "HUB_GID=$(id -g)"
  if [[ $mode == local ]]; then
    echo "HUB_BIND=127.0.0.1"
    echo "HUB_PORT=8080"
  else
    echo "COMPOSE_FILE=docker-compose.yml:deploy/docker-compose.https.yml"
    echo "HTTPS_MODE=$mode"
    echo "HUB_HOST=$host"
    echo "HTTP_PORT=$http_port"
    echo "HTTPS_PORT=$https_port"
    [[ -n $email ]] && echo "ACME_EMAIL=$email"
  fi
} > .env
umask 022
echo "Wrote .env (readable only by you). Back up KEY_PEPPER with ./data: losing it invalidates every key."

if [[ $start -ne 1 ]]; then
  echo "Start it with: docker compose up -d --build"
  echo "The admin password is in .env as ADMIN_PASSWORD. The hub needs it only on the first start: delete that line once you can sign in."
  exit 0
fi

# ── start and wait ─────────────────────────────────────────────────────────────────────────────
wait_healthy() {
  echo -n "Waiting for the hub"
  for _ in $(seq 1 60); do
    if docker compose exec -T agent-hub node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then echo; return 0; fi
    echo -n "."; sleep 2
  done
  echo
  return 1
}
# The hub creates the first admin from ADMIN_PASSWORD only when ./data has no admin yet.
had_db=0; [[ -e data/agent-hub.db ]] && had_db=1
docker compose up -d --build
wait_healthy || die "the hub did not become healthy; check 'docker compose logs agent-hub' (ADMIN_PASSWORD stays in .env until it starts)"

# The admin exists once /health answers (it is created before the server listens). Drop the password
# from .env and recreate the container, so it lives on in neither the file nor the container's environment.
tmp="$(mktemp .env.XXXXXX)"
grep -v '^ADMIN_PASSWORD=' .env > "$tmp"
mv "$tmp" .env
docker compose up -d --force-recreate agent-hub
wait_healthy || die "the hub did not come back after removing ADMIN_PASSWORD from .env; check 'docker compose logs agent-hub'"

case "$mode" in
  local)  console="http://localhost:8080" ;;
  lan)    console="https://$host:$https_port" ;;
  domain) console="https://$host" ;;
esac
if [[ $had_db -eq 1 ]]; then pw_line="(unchanged: ./data already had an admin, so the new password was not used)"
else pw_line="$password      (shown once; it is no longer in .env)"; fi
if [[ $mode == lan ]]; then
  mcp_line="https://$host:$https_port/mcp   (recommended; needs the certificate below)
             $public_url/mcp    (plain HTTP, unencrypted: see the warning below)"
else mcp_line="$public_url/mcp"; fi
cat <<EOF

Agent Hub is running.
  Console    $console
  User       $admin
  Password   $pw_line
  MCP        $mcp_line
  Vault      $vault
EOF
if [[ $mode == lan ]]; then
  cat <<EOF

Port $https_port uses Caddy's internal certificate authority. Export its root once and trust it on
each client machine:
  docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt > agent-hub-root.crt
  Windows: certutil -user -addstore Root agent-hub-root.crt
  macOS:   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain agent-hub-root.crt
  Linux:   sudo cp agent-hub-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
Node.js clients (Claude Code, the PC bridge) may not read the system store. Also set
  NODE_EXTRA_CA_CERTS=/path/to/agent-hub-root.crt
in their environment, then use https://$host:$https_port/mcp and pair bridges with https://$host:$https_port.

WARNING: plain HTTP on port $http_port is kept for clients that do not trust the certificate yet.
On it, app keys, session tokens, session keys, pairing codes and file contents cross the network
in clear text. Use it only on a network you trust and move clients to HTTPS. The console's setup
snippets follow PUBLIC_URL in .env, which stays $public_url; once clients trust the
certificate, set PUBLIC_URL=https://$host:$https_port and run 'docker compose up -d --force-recreate agent-hub'.
EOF
fi
if [[ $mode == domain ]]; then
  echo
  echo "Caddy requests the certificate on first visit; ports 80 and 443 must be reachable from the internet."
fi
