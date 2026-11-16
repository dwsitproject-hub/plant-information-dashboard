FROM node:20-alpine

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

CMD ["node", "src/index.js"]
