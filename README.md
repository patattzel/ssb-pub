# SSB Pub

An invite-only Secure Scuttlebutt pub for Manyverse. It follows invited identities and stores their classic SSB feeds and requested blobs, so other invited peers can sync while the original author is offline.

The server uses the same versions of [ssb-db2](https://github.com/ssbc/ssb-db2), [ssb-ebt](https://github.com/ssbc/ssb-ebt) and ssb-blobs as Manyverse. Replication on the pub is limited to its own feed and the identities it follows directly. Readers can follow individual authors in Manyverse to fetch their posts.

## Docker Compose

For a public pub, run these commands and set `PUB_URL` in `.env` to your HTTPS origin.

```sh
cp .env.example .env
docker compose up -d --build --wait
docker compose exec pub /app/code/pubctl invite
```

Point the DNS name at your HTTPS reverse proxy and forward requests to `127.0.0.1:3000`, including WebSocket upgrades on `/`. For example, with Caddy running on the same host:

```caddyfile
pub.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Paste the resulting link under **Connections → Paste invite code** in Manyverse. Each link can enroll one identity and expires after seven days. The same identity can retry during that time. The operator can show the pub ID and advertised address with `docker compose exec pub /app/code/pubctl status`.

For a local check, run Compose without an `.env` and open `http://127.0.0.1:3000`. Use an HTTPS URL for Manyverse invitations.

### Direct TCP

To use plain TCP as the SSB transport, set `SSB_PORT` in `.env` if port 8008 is already in use and start with both Compose files. Use the same file arguments on subsequent Compose commands.

```sh
docker compose -f compose.yaml -f compose.tcp.yaml up -d --build --wait
docker compose -f compose.yaml -f compose.tcp.yaml exec pub /app/code/pubctl invite
```

The invitation remains an HTTPS link and Manyverse then connects via the advertised TCP port using SSB’s encrypted handshake. Open the chosen TCP port on your firewall and use a DNS record that resolves directly to the server. WebSocket invitations use the default Compose configuration. Clients that support only the original `host:port:@key~seed` invitation format are outside this release’s compatibility.

## Cloudron 10+

The [Cloudron manifest](CloudronManifest.json) defaults to WebSockets over HTTPS. For a source installation, build the image on Docker, push it to a registry Cloudron can pull from, then install it using the Cloudron CLI from this directory. Substitute your registry reference and domains in these commands.

```sh
docker buildx build --platform linux/amd64 --push -t registry.example.com/ssb-pub:0.1.0 .
cloudron login my.example.com
cloudron install --location pub.example.com --port-bindings SSB_PORT=x --image registry.example.com/ssb-pub:0.1.0
```

In the app’s **Web Terminal**, run `/app/code/pubctl invite`. For TCP, enable the **Direct SSB TCP** port on Cloudron or install with `--port-bindings SSB_PORT=18008` using a free port. Use a DNS-only record for a TCP endpoint behind Cloudflare.

### Publish a Community App

For the first release, run `cloudron versions init` and fill in the public app icon URL, screenshot URL, packager name and packager URL in the manifest. A matching `cloudron-v<version>` Git tag triggers the image build, container checks and push to GHCR. Make the package publicly pullable, then add the published image by digest to the catalog and publish the catalog over HTTPS.

```sh
cloudron versions add --image ghcr.io/OWNER/ssb-pub@sha256:DIGEST
cloudron versions verify
```

Use the published `CloudronVersions.json` URL under **App Store → Add custom app → Community app**. This checkout is a local source release.

## Data and backups

The Compose volume `pub-data` keeps the pub identity, feeds, blobs, EBT state and invite database across rebuilds. Cloudron keeps these under `/app/data/ssb-pub` and uses SQLite-aware backups for the invitation database. For a consistent filesystem snapshot of the full data directory, stop the pub before copying. Keep the directory together when restoring, and keep backups private because they include the identity key.

## Development

Use Node.js 24, then run `npm ci` and `npm test`. The integration tests use the Manyverse HTTP invite client and replication scheduler. They exercise invitation claim, joining via WebSocket and TCP, EBT feed replication, blob retrieval and persistence across a restart.
