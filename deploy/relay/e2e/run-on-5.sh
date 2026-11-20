#!/usr/bin/env bash
# Relay end-to-end test on .5 (docs/relay.md, "Testing"). From Git Bash on the dev PC, with CI_HOST set to the test server:
#   bash deploy/relay/e2e/run-on-5.sh [hub worktree]     (default: this repository)
# Copies the hub worktree's tracked files (committed or staged, never untracked ones such as a .env), plus this repository's deploy/relay, to ~/ci/<lane> on .5, and runs e2e.sh there:
# a throwaway hub with temp data, its own Caddy front and the real relay, on a private docker network with no published
# ports. It never touches the live or demo hub and never uses host ports 8080 or 8443. Takes about eight minutes, six of
# them holding the push stream open (STREAM_HOLD_S, default 360). Only tracked files are sent: commit or stage changes first.
set -e
CI_HOST=${CI_HOST:?set CI_HOST to the test server, for example CI_HOST=192.0.2.5}
HERE=$(cd "$(dirname "$0")/../../.." && pwd)
HUB=${1:-$HERE}
LANE=relay-e2e-$$-$RANDOM
cd "$HUB"
git ls-files -c -z | grep -zv '^server/node_modules' | tar --null -T - -cf - | \
  ssh -o BatchMode=yes "$CI_HOST" "rm -rf ~/ci/$LANE && mkdir -p ~/ci/$LANE && tar -xf - -C ~/ci/$LANE"
cd "$HERE"
# Tracked files only here too: a relay .env with a real secret never leaves this PC.
git ls-files -c -z deploy/relay | tar --null -T - -cf - | ssh -o BatchMode=yes "$CI_HOST" "tar -xf - -C ~/ci/$LANE && cp ~/ci/$LANE/deploy/relay/e2e/relay-e2e.test.ts ~/ci/$LANE/server/test/"
ssh -o BatchMode=yes "$CI_HOST" "cd ~/ci/$LANE && STREAM_HOLD_S=${STREAM_HOLD_S:-360} bash deploy/relay/e2e/e2e.sh; rc=\$?; cd ~ && rm -rf ~/ci/$LANE; exit \$rc"
