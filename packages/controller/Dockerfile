# Controller — multi-stage bun build (design.md §4.1)
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy workspace manifests for dependency install
COPY package.json bun.lock* ./
COPY packages/types/package.json ./packages/types/
COPY packages/controller/package.json ./packages/controller/

RUN bun install --frozen-lockfile

# Copy source
COPY packages/types/ ./packages/types/
COPY packages/controller/ ./packages/controller/

# --- Runtime image ---
FROM oven/bun:1

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages

ENV NODE_ENV=production

EXPOSE 9800

ENTRYPOINT ["bun", "run", "packages/controller/src/index.ts"]
