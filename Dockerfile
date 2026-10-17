# WebTS: the bridge and the page in one image. The code and the exact packages are inside the image, so the running
# container can't change its own code; the only writable place is /app/data (the TeamSpeak identities and settings).

# The packages, installed in a separate step: only what runs (the test and type-checking tools stay out).
FROM node:24-alpine AS packages
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine
# Package managers aren't needed to run WebTS: out of the image, with their own dependencies (fewer things to patch).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY package.json ./
COPY --from=packages /app/node_modules ./node_modules
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data /app/sounds && chown node:node /app/data
USER node
ENV NODE_ENV=production DATA_DIR=/app/data SOUNDS_DIR=/app/sounds PORT=3002
EXPOSE 3002
# Healthy = the web server answers. Uses PORT, so it follows a changed port too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
ARG VERSION=dev
LABEL org.opencontainers.image.title="WebTS" \
      org.opencontainers.image.description="A self-hosted web client for TeamSpeak servers: voice, chat, pictures and streams in the browser" \
      org.opencontainers.image.source="https://github.com/KorppuJauho/webts" \
      org.opencontainers.image.licenses="OSL-3.0" \
      org.opencontainers.image.version="${VERSION}"
# Node itself gets the stop signal, so every TeamSpeak connection says goodbye before the container stops.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]
