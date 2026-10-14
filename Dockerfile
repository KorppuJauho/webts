# WebTS: the bridge and the page in one image. The code and the exact packages are inside the image, so the running
# container can't change its own code; the only writable place is /app/data (the TeamSpeak identities and settings).
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data /app/sounds && chown node:node /app/data
USER node
ENV NODE_ENV=production DATA_DIR=/app/data SOUNDS_DIR=/app/sounds PORT=3002
EXPOSE 3002
# Node itself gets the stop signal, so every TeamSpeak connection says goodbye before the container stops.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]
