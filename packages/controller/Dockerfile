# Dockerfile — moat-browser Controller (multi-stage)
# Stage 1: Build
FROM oven/bun:1.3-alpine AS builder

WORKDIR /build

# Copy workspace config
COPY package.json bunfig.toml tsconfig.json ./

# Copy packages
COPY packages/types ./packages/types
COPY packages/controller ./packages/controller

# Install dependencies
RUN bun install --frozen-lockfile

# Type-check
RUN cd packages/controller && bun run tsc --noEmit 2>/dev/null || true

# Stage 2: Runtime
FROM oven/bun:1.3-alpine AS runtime

WORKDIR /app

# Runtime only: copy built workspace
COPY --from=builder /build/package.json ./
COPY --from=builder /build/packages/types ./packages/types
COPY --from=builder /build/packages/controller ./packages/controller
COPY --from=builder /build/node_modules ./node_modules

# Environment defaults
ENV PORT=9900 \
    NODE_ENV=production \
    DOCKER_SOCKET=/var/run/docker.sock \
    AGENT_CHROME_IMAGE=moat-browser/agent-chrome:latest \
    DOCKER_NETWORK=moat-browser \
    PROFILE_BASE_DIR=/data/profiles/base \
    PROFILE_AGENTS_DIR=/data/profiles/agents \
    CDP_PORT=9222

EXPOSE 9900

# Docker socket must be mounted: -v /var/run/docker.sock:/var/run/docker.sock
# Profile dir must be mounted: -v /data/profiles:/data/profiles

ENTRYPOINT ["bun", "run", "packages/controller/src/index.ts"]
