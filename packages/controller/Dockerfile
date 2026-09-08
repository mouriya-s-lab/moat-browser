FROM node:22-slim AS build

ARG BUN_VERSION=1.4.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"
ENV BUN_INSTALL=/root/.bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

WORKDIR /workspace

# Install the exact workspace graph from bun.lock.  npm install cannot consume
# this lockfile and silently resolved a different graph in the old image.
COPY package.json bun.lock tsconfig.json bunfig.toml ./
COPY packages/controller/package.json packages/controller/package.json
COPY packages/controller/tsconfig.json packages/controller/tsconfig.json
COPY packages/types/package.json packages/types/package.json
COPY packages/types/tsconfig.json packages/types/tsconfig.json
COPY packages/e2e/package.json packages/e2e/package.json
RUN bun install --frozen-lockfile --linker hoisted

COPY packages/types/src packages/types/src
RUN bun run --cwd packages/types build

COPY packages/controller/src packages/controller/src
RUN bun run --cwd packages/controller build

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY --from=build /workspace/node_modules /workspace/node_modules
COPY --from=build /workspace/packages/types/package.json packages/types/package.json
COPY --from=build /workspace/packages/types/dist packages/types/dist
COPY --from=build /workspace/packages/controller/package.json packages/controller/package.json
COPY --from=build /workspace/packages/controller/dist packages/controller/dist

WORKDIR /workspace/packages/controller

EXPOSE 3000

CMD ["node", "dist/index.js"]
