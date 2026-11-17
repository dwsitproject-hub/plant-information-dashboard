# Node 22 LTS (Node 20 reached end of life in April 2026).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# backups/ is left out of the image (.dockerignore). Keep an empty one the app user can write,
# for gauge exports and for files copied in with `docker compose cp` during a rollout.
RUN mkdir -p /app/backups && chown node:node /app/backups

# Run as the image's unprivileged "node" user, not root.
USER node

EXPOSE 3010

# Healthy only when the API answers and the database does (busybox wget is in the alpine image).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3   CMD wget -q -O /dev/null http://127.0.0.1:3010/api/v1/health/ready || exit 1

CMD ["node", "src/index.js"]
