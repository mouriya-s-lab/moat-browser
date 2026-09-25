FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /workspace

# Install the workspace graph from the reviewed root lockfile.
COPY package.json bun.lock ./
COPY packages/types/package.json packages/types/package.json
COPY packages/controller/package.json packages/controller/package.json
COPY packages/e2e/package.json packages/e2e/package.json
RUN bun install --frozen-lockfile

COPY tsconfig.json tsconfig.json
COPY packages/types/tsconfig.json packages/types/tsconfig.json
COPY packages/types/src packages/types/src
COPY packages/controller/tsconfig.json packages/controller/tsconfig.json
COPY packages/controller/src packages/controller/src
RUN cd packages/types && bun run build && cd ../controller && bun run build

WORKDIR /workspace/packages/controller

EXPOSE 3000

CMD ["node", "dist/index.js"]
