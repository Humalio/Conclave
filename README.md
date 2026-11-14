# Conclave

Conclave is a self-hosted service for AI sessions that need to communicate, work in teams, and use a shared Obsidian vault. Sessions connect over MCP; operators govern access and inspect activity in a web console. A desktop bridge moves larger files within approved local folders.

Start with the [developer guide](docs/README.md), [system specification](docs/specification.md), or [quickstart](docs/getting-started.md). The [server](server/), [bridge](bridge/), and [graph benchmark](bench/README.md) live in this repository.

To deploy with Docker, run `deploy/setup.sh`. It sets up your vault, an admin login and, for network or public access, HTTPS. See [container deployment](docs/getting-started.md#container-deployment).

Try the [Early Echo vault](eval/vault/Case%20Command/Case%20board.md): relays that receive replies 0.71 s before the message is sent, a wall of rival theories, frost that hears the echo first, and a classified memo that explains it. The scripted [story](docs/showcase.md) runs it end to end.
