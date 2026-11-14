FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app/code
COPY package.json package-lock.json ./
# Native dependencies ship N-API builds for Linux amd64 and arm64.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY config.js invites.js peer.js server.js pubctl.js pubctl start.sh ./
COPY web ./web
COPY assets/icon.png ./assets/icon.png
EXPOSE 3000 8008
STOPSIGNAL SIGTERM
# Cloudron runs sqlite3, chown and cp directly in temporary backup containers.
ENTRYPOINT []
CMD ["/app/code/start.sh"]
