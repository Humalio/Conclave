# Connector releases

This is how a connector version gets from the repository to the PCs. It is the maintainer's job, done on the maintainer's own PC: the release
key never leaves it, and the hub never holds it. The connector checks every release against the public key it carries,
independently of the hub (see [the connector service](connector.md#self-update)).

## Create the release key

```
node deploy/release/connector-release.mjs keygen --out "../private-release-keys"
```

The command writes the private key to `conclave-release-key.pem` in the output folder and prints the public key entry and its ID. Keep the private file outside the repository and make an offline backup. A PC can accept a replacement key if the original key signs it. If you lose both the original and its backup, reinstall the connector on each PC with the new release key.

Put the printed entry into `deploy/client/connector/release-keys.json`, commit it, and publish its id on the Releases
page, so a PC user can compare it. Until this file holds a key, every connector refuses every update.

## Each release

1. Set the version in `deploy/client/connector/version.mjs`, commit, and merge it as usual.
2. On your PC, in a clean checkout of that commit:
   ```
   node deploy/release/connector-release.mjs sign --key "../private-release-keys/conclave-release-key.pem" --out "../connector-release-output"
   ```
   It packs the connector's files into `conclave-connector-<version>.bundle`, writes the manifest
   `conclave-connector-<version>.json` (version, platforms, the bundle's size and SHA-256, the pinned git) and its
   signature `conclave-connector-<version>.json.sig`, then verifies all three again with the public key in
   `release-keys.json` and prints the bundle hash and the key id. It also writes the installer,
   `conclave-install-<version>.mjs`: the template `deploy/client/install.mjs` with this version, the Releases page and
   the public keys of `release-keys.json` filled in (with a rollover, the new key too), and prints its SHA-256.
3. Make a GitHub release with the tag `connector-v<version>` on the Conclave repository and upload the four files.
   Put the key id on the release page: the installer prints it, and a PC user compares the two.
4. In the console, **Connector versions**, approve the version. PCs with auto-update on take it within a few hours; or
   use **Update** on a PC page to send it to one PC now.

## Changing the release key

```
node deploy/release/connector-release.mjs rollover --old-key "../private-release-keys/conclave-release-key.pem" --new-key "../private-release-keys/next/conclave-release-key.pem"
```

It prints a rollover statement: the new key's entry signed by the old key. Add the new key to `release-keys.json`, and
sign the next release with the **new** key and `--rollover <the statement file>`. A connector that only knows the old key
accepts that release because the old key vouches for the new one; the build it installs carries the new key. Keep the old
key until every PC has updated past that release.

## What a PC refuses

An unsigned release, a signature by a key the PC does not carry (without a rollover from one it does), a manifest for
another version or platform, a version at or below the one it runs, a version the operator did not approve, and a bundle
whose size, hash or file paths differ from the signed manifest. The installer refuses the same, with no hub reachable,
and also a release for another version than its own and one older than the build already installed. Tests:
`deploy/client/connector-service.test.mjs` and `deploy/client/connector-onboarding.test.mjs`, with throwaway keys only.
