FROM oven/bun:latest AS builder

WORKDIR /app
COPY packages/types/package.json packages/types/package.json
COPY packages/controller/package.json packages/controller/package.json
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY packages/types/ packages/types/
COPY packages/controller/ packages/controller/
COPY tsconfig.json ./

FROM oven/bun:latest

WORKDIR /app
COPY --from=builder /app /app

RUN mkdir -p /run/moat-browser /data/profiles/frozen /data/profiles/live

CMD ["bun", "run", "packages/controller/src/index.ts"]
