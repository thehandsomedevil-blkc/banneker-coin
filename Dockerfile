# syntax=docker/dockerfile:1

# Build native modules (better-sqlite3) on the same glibc base used at runtime.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY vite.config.js postcss.config.js tailwind.config.js index.html ./
COPY src ./src
COPY shared ./shared
RUN npm run build

FROM deps AS prod-deps
WORKDIR /app
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4174 \
    DB_PATH=/data/bnkr.db \
    ALLOW_LOCAL_PEERS=false \
    SEED_PEERS=https://banneker-coin.onrender.com,https://the-black-coin.onrender.com,https://banneker-coin-node-b.onrender.com
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
USER node
VOLUME ["/data"]
EXPOSE 4174
CMD ["node", "server/index.js"]
