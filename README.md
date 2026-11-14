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

In Cloudron, open **App Store → Add custom app → Community app** and paste the [SSB Pub install URL](https://raw.githubusercontent.com/patattzel/ssb-pub/main/CloudronVersions.json).

```text
https://raw.githubusercontent.com/patattzel/ssb-pub/main/CloudronVersions.json
```

Choose a domain. The [Cloudron manifest](CloudronManifest.json) defaults to WebSockets over HTTPS. For a CLI installation, substitute your Cloudron and app domains:

```sh
cloudron login my.example.com
cloudron install --location pub.example.com --port-bindings SSB_PORT=x --versions-url https://raw.githubusercontent.com/patattzel/ssb-pub/main/CloudronVersions.json
```

For TCP, enable the **Direct SSB TCP** port on Cloudron or install with `--port-bindings SSB_PORT=18008` using a free port. Use a DNS-only record for a TCP endpoint behind Cloudflare.

## Admin sign-in

1. Copy your public SSB ID from your Manyverse profile. It starts with `@` and ends with `.ed25519`.
2. In Cloudron’s **Web Terminal**, run `/app/code/pubctl admin` and paste the ID. With Compose, run `docker compose exec pub /app/code/pubctl admin`.
3. Open the pub, choose **Admin sign-in → Open Manyverse**, and approve the login in Manyverse. To sign in using a phone, open **Use Manyverse on another device** and scan the QR code. Keep the original browser open.
4. Under **Pub settings**, change the name, description and image or create an invite. Saving the profile publishes a signed SSB `about` message and stores the image as an SSB blob, so peers replicating the pub’s feed can see the profile in Manyverse.

To enable or reset the password fallback, run `/app/code/pubctl password` in the same terminal. **Admin sign-in** then offers a password form. Resetting the password signs out existing web sessions. Running `pubctl admin` with a different ID replaces the administrator, clears the fallback password and signs out old sessions. Upgrading from 0.1.0 keeps the existing pub identity, replicated data and invitations.

### Publish a Community App

Update the version and changelog in `CloudronManifest.json`. A matching `cloudron-v<version>` Git tag triggers the image build, container checks and push to GitHub Container Registry. Verify public pull access and add the new image to the catalog by digest:

```sh
cloudron versions add --image ghcr.io/patattzel/ssb-pub@sha256:DIGEST
cloudron versions verify
```

Commit and push the updated `CloudronVersions.json` to `main`.

## Data and backups

The Compose volume `pub-data` keeps the pub identity, feeds, blobs, EBT state, invitations and admin credentials across rebuilds. Cloudron keeps these under `/app/data/ssb-pub` and uses SQLite-aware backups for invitations and admin settings. For a consistent filesystem snapshot of the full data directory, stop the pub before copying. Keep the directory together when restoring, and keep backups private because they include the identity key.

## Development

Use Node.js 24, then run `npm ci` and `npm test`. The integration tests use the Manyverse HTTP auth and invite clients and replication scheduler. They exercise admin sign-in, profile editing, invitation claim, joining via WebSocket and TCP, EBT feed replication, blob retrieval and persistence across a restart.
