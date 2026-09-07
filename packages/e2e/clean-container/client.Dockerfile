# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/moat-source
COPY source/ /opt/moat-source/
COPY input/moat-x86_64-linux /input/moat-x86_64-linux
COPY input/moat-x86_64-linux.sha256 /input/moat-x86_64-linux.sha256
COPY source-identity.json /opt/source-identity.json
COPY harness/ /opt/harness/

RUN chmod 0755 /opt/moat-source/scripts/install.sh \
    /opt/moat-source/packages/e2e/cli-all-commands.sh \
    /opt/harness/client-entrypoint.sh \
    /opt/harness/run-matrix.sh \
    /opt/harness/run-basic.sh

ENTRYPOINT ["/opt/harness/client-entrypoint.sh"]
