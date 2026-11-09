FROM node:22-alpine

# docker CLI + compose plugin: SelfCluster runs `docker compose` against the host's socket.
RUN apk add --no-cache docker-cli docker-cli-compose tini

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=7443 \
    DATA_DIR=/data \
    STACKS_DIR=/opt/stacks
EXPOSE 7443
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

# Runs as root: it needs the Docker socket, which is root-equivalent anyway.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
