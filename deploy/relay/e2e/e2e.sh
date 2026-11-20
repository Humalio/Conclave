#!/usr/bin/env bash
# Relay end-to-end test, the part that runs on .5 (run-on-5.sh copies the hub and calls it). Runs in ~/ci/<lane>.
# A private docker network, no published ports: never the live or demo hub, never 8080/8443 on the host.
set -u
LANE=$(pwd); NET=rlye2e-$$; SH=$(mktemp -d); chmod 777 "$SH"
VOL=rlye2e-data-$$; HVOL=rlye2e-hubtls-$$
cleanup() { docker rm -f e2e-hub-$$ e2e-hubtls-$$ e2e-relay-$$ >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; docker volume rm $VOL $HVOL >/dev/null 2>&1; rm -rf "$SH"; }
trap cleanup EXIT
docker network create --subnet 172.31.77.0/24 $NET >/dev/null
wait_file() { for _ in $(seq 1 6000); do [ -e "$SH/$1" ] && return 0; [ -e "$SH/done" ] && return 1; sleep 0.2; done; return 1; }

# The hub's own HTTPS front, as production has one: name hub.test, its own internal CA (the relay trusts it for this test only).
printf 'https://hub.test {\n\ttls internal\n\treverse_proxy 172.31.77.20:8080\n}\n' > "$SH/hubtls.Caddyfile"
# Test-only overlay: the relay trusts the hubtls CA instead of the public roots. Everything else is the shipped file.
sed -e 's#tls_server_name {$HUB_NAME}#tls_server_name {$HUB_NAME}\n\t\t\t\ttls_trust_pool file /hubdata/caddy/pki/authorities/local/root.crt#' deploy/relay/relay.Caddyfile > "$SH/relay.Caddyfile"
grep -q tls_trust_pool "$SH/relay.Caddyfile" || { echo "overlay failed"; exit 1; }

docker run -d --name e2e-hub-$$ --network $NET --ip 172.31.77.20 -e CI=1 -e NO_COLOR=1 -e STREAM_HOLD_S=${STREAM_HOLD_S:-360} -v "$LANE":/w -v conclave-ci-nm:/w/server/node_modules -v "$SH":/shared -w /w/server conclave-ci:24 \
  sh -c 'npx vitest run test/relay-e2e.test.ts > /shared/vitest.txt 2>&1; echo EXIT=$? >> /shared/vitest.txt; touch /shared/done' >/dev/null
docker run -d --name e2e-hubtls-$$ --network $NET --ip 172.31.77.11 --network-alias hub.test -v "$SH/hubtls.Caddyfile":/etc/caddy/Caddyfile:ro -v $HVOL:/data caddy:2.10.2-alpine >/dev/null

relay() { docker run -d --name e2e-relay-$$ --network $NET --ip 172.31.77.10 \
  -e RELAY_HOST=172.31.77.10 -e HUB_NAME=hub.test -e HUB_UPSTREAM=hub.test:443 -e RELAY_SECRET="$1" -e HTTP_PORT=9080 -e HTTPS_PORT=9443 \
  -v "$SH/relay.Caddyfile":/etc/caddy/Caddyfile:ro -v $VOL:/data -v $HVOL:/hubdata:ro caddy:2.10.2-alpine >/dev/null; }

wait_file hub-up || { echo "hub never came up"; cat "$SH/vitest.txt"; exit 1; }
sleep 2   # hubtls has made its CA by now
relay ""  # first start, no secret: the CA is made, requests count as direct
sleep 3; touch "$SH/relay-up"
wait_file secret-ready && {
  docker logs e2e-relay-$$ > "$SH/relay.log" 2>&1   # keep the first run's log for the check
  docker rm -f e2e-relay-$$ >/dev/null; relay "$(cat "$SH/secret")"; rm -f "$SH/secret"; sleep 3; touch "$SH/relay-restarted"; }
wait_file drop && { docker logs e2e-relay-$$ >> "$SH/relay.log" 2>&1; docker restart -t 0 e2e-relay-$$ >/dev/null; sleep 3; touch "$SH/relay-back"; }
wait_file done; timeout 120 docker wait e2e-hub-$$ >/dev/null 2>&1
docker logs --since 0 e2e-relay-$$ 2>/dev/null | tail -n +1 >> "$SH/relay.log"

echo "=== vitest"; grep -E "✓|✗|×|FAIL|Test Files|Tests |AssertionError|Error:|expected|EXIT=" "$SH/vitest.txt" | head -60
echo "=== stream"; cat "$SH/report" 2>/dev/null
echo "=== relay log: $(wc -l < "$SH/relay.log") lines"
hits=0; while IFS= read -r n; do [ -n "$n" ] && grep -qF -- "$n" "$SH/relay.log" && { hits=$((hits+1)); echo "LEAK: a test secret is in the relay log"; }; done < "$SH/needles"
echo "secrets checked: $(grep -c . "$SH/needles"), found in log: $hits"
for w in '"headers"' authorization cookie x-conclave-relay x-csrf-token mcp-session-id 'installation=' 'path=' ah_ cnv_; do c=$(grep -ci -- "$w" "$SH/relay.log"); echo "log lines with $w: $c"; done
echo "=== sample access lines"; grep '"handled request"' "$SH/relay.log" | head -3 | cut -c1-400
grep -q "EXIT=0" "$SH/vitest.txt"
