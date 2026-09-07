# syntax=docker/dockerfile:1.7
FROM node:22.14.0-bookworm-slim AS node-toolchain

FROM rust:1.95.0-bookworm AS rust-builder
COPY --from=node-toolchain /usr/local/bin/node /usr/local/bin/node


ARG BUN_VERSION=1.4.1
ARG SOURCE_COMMIT=unknown

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    python3 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"
ENV BUN_INSTALL=/root/.bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

WORKDIR /source
COPY . .

RUN test -f cli/Cargo.lock \
    && test -f bun.lock \
    && cargo build --release --locked --workspace --manifest-path cli/Cargo.toml \
    && bun install --frozen-lockfile \
    && bun run --cwd packages/types build \
    && bun run --cwd packages/controller build

RUN mkdir -p /out \
    && cp cli/target/release/moat /out/moat-x86_64-linux \
    && sha256sum /out/moat-x86_64-linux > /out/moat-x86_64-linux.sha256 \
    && printf '%s\n' "${SOURCE_COMMIT}" > /out/source-commit \
    && { rustc --version; cargo --version; bun --version; node --version; } > /out/toolchain-versions.txt \
    && find packages/types/dist packages/controller/dist -type f -print | sort > /out/generated-files.txt

FROM scratch AS artifacts
COPY --from=rust-builder /out /out
