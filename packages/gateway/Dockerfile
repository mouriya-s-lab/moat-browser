FROM oven/bun:latest AS builder

WORKDIR /app
COPY packages/types/package.json packages/types/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY packages/types/ packages/types/
COPY packages/gateway/ packages/gateway/
COPY tsconfig.json ./

FROM oven/bun:latest

WORKDIR /app
COPY --from=builder /app /app

EXPOSE 9800

CMD ["bun", "run", "packages/gateway/src/index.ts"]
