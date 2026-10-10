# Agent Hub bridge

The bridge runs under the PC user's account and moves files for that PC's authorized jobs. It requires Node.js 24 or later and has no package dependencies. Use the bridge program delivered by your hub so both ends use the same protocol. See [transfer design](../docs/transfers.md).

## Install and check

1. Open the PC setup flow in the console. Use a configured desktop app on that PC to run the setup handoff. Assemble the program in the returned order and verify its SHA-256 before running it.
2. Pair using the short-lived code in the handoff. Use an HTTPS hub address for remote connections. Keep the bridge configuration private to the account running the bridge.
3. Register the generated user task or service. Windows uses Task Scheduler at logon, macOS uses a LaunchAgent, and Linux uses a systemd user unit. Resolve the absolute Node executable when configuring the service.
4. Approve dedicated input and output folders in the console. Confirm the bridge heartbeat and transfer a small file in both directions before using it for larger work. Keep the Node executable, bridge program and its configuration outside transfer roots.

## Upgrade and recover

Stop the existing task or service. Replace the program with the verified copy delivered by the upgraded hub, then restart the same task or service. Keep `~/.agent-hub/bridge.json` to retain pairing. Re-pair from the console if the key was revoked. Run only one bridge process per local configuration.

An interrupted transfer can resume while the channel remains open. Keep the original source files stable until completion. The receiver stages bytes in an `.ah-….part` file and keeps it until the hub acknowledges publication. The receiver validates a folder manifest before publishing and replaces individual files atomically. Use a dedicated destination because a transfer can replace existing files and publication of a folder is not a single atomic operation. If a process dies after the hub closes a channel, remove its leftover staging files only after confirming the channel is terminal and the bridge is stopped.

Use narrow roots and send an explicitly prepared folder for sensitive transfers. The built-in ignore matcher handles common patterns for folder walks. Treat it as a convenience filter and review what you are sending. The bridge refuses symbolic links and junctions below approved roots, hard-linked source files, and reserved transfer paths in incoming streams. Keep approved directories under the service account's control.

For local diagnosis, run `node agent-hub-bridge.mjs run` in a terminal after stopping the scheduled instance. Check the hub address, heartbeat, local folder approval and the channel's failure reason. On systems that deliver SIGINT or SIGTERM to Node, the bridge cancels polling and waits for active jobs to stop.
