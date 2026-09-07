#!/usr/bin/env bash
set -Eeuo pipefail

# Issue #235 clean-container acceptance. This script owns only resources carrying
# the moat-clean235 run label and always uses a fresh inner Docker daemon.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_EVIDENCE_ROOT="/Users/mouriya/Ext/work/orca/moat-clean-build-execution"
PHASE="prepare"
SOURCE_COMMIT=""
EVIDENCE_DIR=""
OUTER_DOCKER_HOST="${MOAT_CLEAN_OUTER_DOCKER_HOST:-}"
DIND_IMAGE="${MOAT_CLEAN_DIND_IMAGE:-docker:29-dind@sha256:c9da39e30475d7bf353436738239d02fb1c2a52a1c968322beccb6ec239707d8}"
DIND_PLATFORM="${MOAT_CLEAN_DIND_PLATFORM:-linux/arm64}"
KEEP_RUNTIME=0
STATE_LOADED=0
CLEANUP_OK=1

usage() {
  cat <<'EOF'
Usage: scripts/clean-container-test.sh [options]
Phases:
  prepare       export the fixed source, cold-build all artifacts, start isolated
                fixture/neko/Controller runtime, and emit browser-session.json.
  restart-user  stop/start user-chrome against the same /data/profile source
                after real neko login, recording the persisted-profile proof.
  finish        consume the prepared runtime after login and restart, run rows
                4-8, capture evidence, and destroy only this run's resources.

Options:
  --phase prepare|restart-user|finish
  --source-commit SHA       immutable commit to export (defaults to HEAD)
  --evidence-dir PATH       durable directory under the issue-235 evidence root
  --outer-docker-host URL   optional host daemon used only to start DinD
  --dind-image IMAGE        pinned DinD image reference
EOF
}

die() {
  echo "clean-container-test: $*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --phase)
      (($# >= 2)) || die "--phase requires prepare or finish"
      PHASE="$2"
      shift 2
      ;;
    --source-commit)
      (($# >= 2)) || die "--source-commit requires a commit SHA"
      SOURCE_COMMIT="$2"
      shift 2
      ;;
    --evidence-dir)
      (($# >= 2)) || die "--evidence-dir requires a path"
      EVIDENCE_DIR="$2"
      shift 2
      ;;
    --outer-docker-host)
      (($# >= 2)) || die "--outer-docker-host requires a Docker endpoint"
      OUTER_DOCKER_HOST="$2"
      shift 2
      ;;
    --dind-image)
      (($# >= 2)) || die "--dind-image requires an image reference"
      DIND_IMAGE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done
case "$PHASE" in
  prepare|restart-user|finish) ;;
  *) die "--phase must be prepare, restart-user, or finish" ;;
esac

if [[ -z "$EVIDENCE_DIR" ]]; then
  if [[ "$PHASE" == prepare ]]; then
    run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    EVIDENCE_DIR="${DEFAULT_EVIDENCE_ROOT}/issue235-${run_stamp}-$$"
  else
    die "--evidence-dir is required for ${PHASE}"
  fi
fi
EVIDENCE_DIR="$(cd "$(dirname "$EVIDENCE_DIR")" && mkdir -p "$(basename "$EVIDENCE_DIR")" && cd "$(basename "$EVIDENCE_DIR")" && pwd)"

mkdir -p "$EVIDENCE_DIR"/{source,build,images,runtime,client,cleanup}
chmod 0700 "$EVIDENCE_DIR"
LOG_DIR="$EVIDENCE_DIR/rawlogs"
mkdir -p "$LOG_DIR"

# Never inherit an inner DOCKER_HOST while inspecting or starting the outer
# OrbStack daemon. A caller may explicitly choose a host endpoint, but it is
# still recorded and never mounted into a product container.
HOST_DOCKER_ARGS=()
if [[ -n "$OUTER_DOCKER_HOST" ]]; then
  HOST_DOCKER_ARGS=(--host "$OUTER_DOCKER_HOST")
fi
host_docker() {
  env -u DOCKER_HOST docker "${HOST_DOCKER_ARGS[@]}" "$@"
}

run_logged() {
  local name="$1"
  shift
  local log="$LOG_DIR/${name}.log"
  set +e
  "$@" >"$log" 2>&1
  local status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    echo "clean-container-test: command failed (${name}, exit ${status}); see ${log}" >&2
  fi
  return "$status"
}

json_file() {
  local path="$1"
  local value="$2"
  printf '%s\n' "$value" > "$path"
}

pick_tcp_port() {
  python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

pick_udp_base() {
  python3 - <<'PY'
import socket
for base in range(52000, 52900, 101):
    sockets = []
    try:
        for port in range(base, base + 101):
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.bind(("127.0.0.1", port))
            sockets.append(sock)
        print(base)
        break
    except OSError:
        for sock in sockets:
            sock.close()
else:
    raise SystemExit("no free UDP range of 101 ports")
for sock in sockets:
    sock.close()
PY
}

wait_for() {
  local name="$1" attempts="$2"
  shift 2
  local i
  for ((i=0; i<attempts; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "clean-container-test: timeout waiting for ${name}" >&2
  return 1
}

source_required_commit() {
  if [[ -z "$SOURCE_COMMIT" ]]; then
    SOURCE_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  fi
  git -C "$REPO_ROOT" cat-file -e "${SOURCE_COMMIT}^{commit}" \
    || die "source commit is not a local commit: ${SOURCE_COMMIT}"
  [[ "$SOURCE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] \
    || die "source commit must be a full 40-character SHA: ${SOURCE_COMMIT}"
}

write_fixture_secrets() {
  local secret_file="$EVIDENCE_DIR/fixture-secrets.env"
  if [[ -f "$secret_file" ]]; then
    # shellcheck disable=SC1090
    source "$secret_file"
    return
  fi
  umask 077
  local suffix
  suffix="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(6))
PY
)"
  FIXTURE_USERNAME="clean-user-${suffix}"
  FIXTURE_PASSWORD="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(24))
PY
)"
  FIXTURE_IDENTITY="clean-container-user"
  NEKO_USER_PASSWORD="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(18))
PY
)"
  NEKO_ADMIN_PASSWORD="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(18))
PY
)"
  {
    printf 'FIXTURE_USERNAME=%q\n' "$FIXTURE_USERNAME"
    printf 'FIXTURE_PASSWORD=%q\n' "$FIXTURE_PASSWORD"
    printf 'FIXTURE_IDENTITY=%q\n' "$FIXTURE_IDENTITY"
    printf 'NEKO_USER_PASSWORD=%q\n' "$NEKO_USER_PASSWORD"
    printf 'NEKO_ADMIN_PASSWORD=%q\n' "$NEKO_ADMIN_PASSWORD"
  } > "$secret_file"
  chmod 0600 "$secret_file"
}

load_state() {
  [[ -f "$EVIDENCE_DIR/state.env" ]] || die "missing prepared state: $EVIDENCE_DIR/state.env"
  # state.env is generated exclusively by this script and contains no secrets.
  # shellcheck disable=SC1091
  source "$EVIDENCE_DIR/state.env"
  STATE_LOADED=1
  [[ "${STATE_VERSION:-}" == "1" ]] || die "unsupported state version"
  [[ -n "${RUN_ID:-}" && -n "${DIND_NAME:-}" && -n "${INNER_DOCKER_HOST:-}" ]] \
    || die "prepared state is incomplete"
}

inner_docker() {
  [[ -n "${INNER_DOCKER_HOST:-}" ]] || die "inner Docker endpoint is not configured"
  env -u DOCKER_HOST docker --host "$INNER_DOCKER_HOST" "$@"
}

record_outer_preflight() {
  run_logged orb-list bash -c 'command -v orb >/dev/null 2>&1 && orb list || true'
  run_logged outer-docker-ps host_docker ps -a --no-trunc
  run_logged outer-docker-info host_docker info
  run_logged outer-docker-version host_docker version
}

record_inner_info() {
  inner_docker info > "$EVIDENCE_DIR/runtime/inner-docker-info.txt"
  inner_docker version > "$EVIDENCE_DIR/runtime/inner-docker-version.txt"
  inner_docker ps -a --no-trunc > "$EVIDENCE_DIR/runtime/inner-docker-ps.txt"
}

image_identity() {
  local name="$1" path="$2" raw
  raw="$(inner_docker image inspect "$name" --format '{{json .}}')"
  python3 - "$path" "$raw" <<'PY'
import json
import pathlib
import sys
value = json.loads(sys.argv[2])
pathlib.Path(sys.argv[1]).write_text(json.dumps({
    "id": value.get("Id"),
    "repoDigests": value.get("RepoDigests", []),
    "created": value.get("Created"),
    "architecture": value.get("Architecture"),
    "os": value.get("Os"),
    "config": {
        "entrypoint": value.get("Config", {}).get("Entrypoint"),
        "cmd": value.get("Config", {}).get("Cmd"),
    },
}, sort_keys=True) + "\n")
PY
}

runtime_identity() {
  local name="$1" path="$2" raw
  raw="$(inner_docker inspect "$name" --format '{{json .}}')"
  python3 - "$path" "$raw" <<'PY'
import json
import pathlib
import sys
value = json.loads(sys.argv[2])
config = value.get("Config", {})
pathlib.Path(sys.argv[1]).write_text(json.dumps({
    "id": value.get("Id"),
    "name": value.get("Name"),
    "image": config.get("Image"),
    "state": value.get("State", {}).get("Status"),
    "mounts": value.get("Mounts", []),
    "network": value.get("NetworkSettings", {}).get("Networks", {}),
    "labels": config.get("Labels", {}),
}, sort_keys=True) + "\n")
PY
}

wait_inner_http() {
  local container="$1" url="$2"
  wait_for "${container} ${url}" 90 inner_docker exec "$container" node -e "fetch('${url}').then(r=>{if(!r.ok) process.exit(1)}).catch(()=>process.exit(1))"
}

prepare_source() {
  source_required_commit
  local archive="$EVIDENCE_DIR/source/source.tar"
  git -C "$REPO_ROOT" archive --format=tar --prefix=source/ "$SOURCE_COMMIT" > "$archive"
  tar -xf "$archive" -C "$EVIDENCE_DIR/source"
  local source_dir="$EVIDENCE_DIR/source/source"
  for required in \
    scripts/install.sh \
    scripts/cli-command-contract.py \
    cli/Cargo.lock \
    cli/Cargo.toml \
    packages/types/src/index.ts \
    packages/controller/Dockerfile \
    packages/e2e/cli-all-commands.ts \
    packages/e2e/clean-container/fixture.Dockerfile \
    packages/e2e/clean-container/fixture.mjs \
    packages/e2e/clean-container/replay.py; do
    [[ -e "$source_dir/$required" ]] || die "source commit lacks required path: $required"
  done
  sha256sum "$archive" > "$EVIDENCE_DIR/source/source.tar.sha256"
  git -C "$REPO_ROOT" ls-tree -r --name-only "$SOURCE_COMMIT" > "$EVIDENCE_DIR/source/tree.txt"
  git -C "$REPO_ROOT" show -s --format='%H%n%P%n%s' "$SOURCE_COMMIT" > "$EVIDENCE_DIR/source/commit.txt"
  SOURCE_DIR="$source_dir"
  export SOURCE_DIR
}

build_image() {
  local name="$1"
  local tag="$2"
  local dockerfile="$3"
  local context="$4"
  shift 4
  run_logged "build-${name}" inner_docker buildx build \
    --pull --no-cache --platform linux/amd64 --provenance=mode=max --sbom=false --load \
    --metadata-file "$EVIDENCE_DIR/build/${name}-metadata.json" \
    --label "moat.clean235.run=${RUN_ID}" --label "moat.clean235.source=${SOURCE_COMMIT}" \
    "$@" -f "$dockerfile" -t "$tag" "$context"
}

image_id_from_file() {
  python3 - "$1" <<'PY'
import json
import pathlib
import sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
image_id = value.get("id")
if not isinstance(image_id, str) or not image_id.startswith("sha256:"):
    raise SystemExit(f"image identity has no immutable id: {sys.argv[1]}")
print(image_id)
PY
}

record_base_metadata() {
  local output="$1"
  shift
  python3 - "$output" "$@" <<'PY'
import json
import pathlib
import re
import sys

output = pathlib.Path(sys.argv[1])
metadata_paths = [pathlib.Path(item) for item in sys.argv[2:]]
materials = {}

def decode(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value

def visit(value):
    value = decode(value)
    if isinstance(value, dict):
        uri = value.get("uri")
        digest = value.get("digest")
        if isinstance(uri, str) and (
            uri.startswith("docker-image://") or uri.startswith("pkg:docker/")
        ):
            if digest is None:
                match = re.search(r"@(?P<algorithm>sha256):(?P<value>[0-9a-f]{64})$", uri)
                if match:
                    digest = {match.group("algorithm"): match.group("value")}
            if digest is None:
                raise SystemExit(f"build resolver metadata lacks digest for {uri}")
            materials[(uri, json.dumps(digest, sort_keys=True))] = {
                "uri": uri,
                "digest": digest,
            }
        for child in value.values():
            visit(child)
    elif isinstance(value, list):
        for child in value:
            visit(child)

for path in metadata_paths:
    if not path.is_file():
        raise SystemExit(f"missing build resolver metadata: {path}")
    visit(json.loads(path.read_text()))

resolved = sorted(materials.values(), key=lambda item: item["uri"])
if not resolved:
    raise SystemExit("build resolver metadata contained no registry base-image digests")
output.write_text(json.dumps({
    "metadataFiles": [str(path) for path in metadata_paths],
    "materials": resolved,
}, indent=2, sort_keys=True) + "\n")
with output.with_suffix(".txt").open("w") as text:
    for item in resolved:
        text.write(f'{item["uri"]}\t{json.dumps(item["digest"], sort_keys=True)}\n')
PY
}

build_all() {
  local build_tag="moat-clean235-${RUN_ID}-build"
  local controller_tag="moat-clean235-${RUN_ID}-controller"
  local agent_tag="moat-clean235-${RUN_ID}-agent"
  local user_tag="moat-clean235-${RUN_ID}-user"
  local fixture_tag="moat-clean235-${RUN_ID}-fixture"
  local client_tag="moat-clean235-${RUN_ID}-client"
  BUILD_IMAGE="$build_tag"
  CONTROLLER_IMAGE="$controller_tag"
  AGENT_IMAGE="$agent_tag"
  USER_IMAGE="$user_tag"
  FIXTURE_IMAGE="$fixture_tag"
  CLIENT_IMAGE="$client_tag"
  export BUILD_IMAGE CONTROLLER_IMAGE AGENT_IMAGE USER_IMAGE FIXTURE_IMAGE CLIENT_IMAGE

  build_image build "$BUILD_IMAGE" \
    "$SOURCE_DIR/packages/e2e/clean-container/build.Dockerfile" "$SOURCE_DIR" \
    --build-arg "SOURCE_COMMIT=${SOURCE_COMMIT}" \
    || die "Linux amd64 builder failed"

  local builder_container="moat-clean235-${RUN_ID}-builder-export"
  inner_docker create --name "$builder_container" "$BUILD_IMAGE" >/dev/null
  inner_docker cp "$builder_container:/out/moat-x86_64-linux" "$EVIDENCE_DIR/build/moat-x86_64-linux"
  inner_docker cp "$builder_container:/out/moat-x86_64-linux.sha256" "$EVIDENCE_DIR/build/moat-x86_64-linux.sha256"
  inner_docker cp "$builder_container:/out/toolchain-versions.txt" "$EVIDENCE_DIR/build/toolchain-versions.txt"
  inner_docker cp "$builder_container:/out/generated-files.txt" "$EVIDENCE_DIR/build/generated-files.txt"
  inner_docker rm "$builder_container" >/dev/null
  chmod 0755 "$EVIDENCE_DIR/build/moat-x86_64-linux"
  CLI_SHA256="$(cut -d ' ' -f 1 < "$EVIDENCE_DIR/build/moat-x86_64-linux.sha256")"
  export CLI_SHA256

  build_image controller "$CONTROLLER_IMAGE" \
    "$SOURCE_DIR/packages/controller/Dockerfile" "$SOURCE_DIR" \
    || die "Controller image build failed"
  build_image agent "$AGENT_IMAGE" \
    "$SOURCE_DIR/images/agent-chrome/Dockerfile" "$SOURCE_DIR/images/agent-chrome" \
    || die "agent-chrome image build failed"
  build_image user "$USER_IMAGE" \
    "$SOURCE_DIR/images/user-chrome/Dockerfile" "$SOURCE_DIR/images/user-chrome" \
    || die "user-chrome image build failed"
  build_image fixture "$FIXTURE_IMAGE" \
    "$SOURCE_DIR/packages/e2e/clean-container/fixture.Dockerfile" \
    "$SOURCE_DIR/packages/e2e/clean-container" \
    || die "fixture image build failed"

  local context="$EVIDENCE_DIR/build/client-context"
  mkdir -p "$context/source" "$context/input" "$context/harness"
  cp -a "$SOURCE_DIR/cli" "$context/source/cli"
  mkdir -p "$context/source/packages/types" "$context/source/packages/controller" "$context/source/packages/e2e/clean-container" "$context/source/scripts"
  cp -a "$SOURCE_DIR/packages/types/src" "$context/source/packages/types/src"
  cp -a "$SOURCE_DIR/packages/controller/src" "$context/source/packages/controller/src"
  cp -a "$SOURCE_DIR/packages/e2e/cli-all-commands.ts" "$context/source/packages/e2e/cli-all-commands.ts"
  cp -a "$SOURCE_DIR/packages/e2e/cli-all-commands.sh" "$context/source/packages/e2e/cli-all-commands.sh"
  cp -a "$SOURCE_DIR/scripts/cli-command-contract.py" "$context/source/scripts/cli-command-contract.py"
  cp -a "$SOURCE_DIR/scripts/install.sh" "$context/source/scripts/install.sh"
  cp -a "$SOURCE_DIR/packages/e2e/clean-container/replay.py" "$context/source/packages/e2e/clean-container/replay.py"
  cp "$EVIDENCE_DIR/build/moat-x86_64-linux" "$context/input/moat-x86_64-linux"
  cp "$EVIDENCE_DIR/build/moat-x86_64-linux.sha256" "$context/input/moat-x86_64-linux.sha256"
  cp "$SOURCE_DIR/packages/e2e/clean-container/client.Dockerfile" "$context/client.Dockerfile"
  python3 - "$context/source-identity.json" "$SOURCE_COMMIT" "$CLI_SHA256" <<'PY'
import json
import pathlib
import sys
pathlib.Path(sys.argv[1]).write_text(json.dumps({
    "sourceCommit": sys.argv[2],
    "cliSha256": sys.argv[3],
    "runnerRoot": "/opt/moat-source",
}, sort_keys=True) + "\n")
PY
  cp "$SOURCE_DIR/packages/e2e/clean-container/client-entrypoint.sh" "$context/harness/client-entrypoint.sh"
  cp "$SOURCE_DIR/packages/e2e/clean-container/run-matrix.sh" "$context/harness/run-matrix.sh"
  cp "$SOURCE_DIR/packages/e2e/clean-container/run-basic.sh" "$context/harness/run-basic.sh"

  build_image client "$CLIENT_IMAGE" "$context/client.Dockerfile" "$context" \
    || die "client runner image build failed"

  mkdir -p "$EVIDENCE_DIR/images"
  for pair in \
    "build:${BUILD_IMAGE}" \
    "controller:${CONTROLLER_IMAGE}" \
    "agent:${AGENT_IMAGE}" \
    "user:${USER_IMAGE}" \
    "fixture:${FIXTURE_IMAGE}" \
    "client:${CLIENT_IMAGE}"; do
    local key="${pair%%:*}" image="${pair#*:}"
    image_identity "$image" "$EVIDENCE_DIR/images/${key}.json"
  done
  record_base_metadata "$EVIDENCE_DIR/images/base-identities.json" \
    "$EVIDENCE_DIR/build/build-metadata.json" \
    "$EVIDENCE_DIR/build/controller-metadata.json" \
    "$EVIDENCE_DIR/build/agent-metadata.json" \
    "$EVIDENCE_DIR/build/user-metadata.json" \
    "$EVIDENCE_DIR/build/fixture-metadata.json" \
    "$EVIDENCE_DIR/build/client-metadata.json"
  BUILD_IMAGE="$(image_id_from_file "$EVIDENCE_DIR/images/build.json")"
  CONTROLLER_IMAGE="$(image_id_from_file "$EVIDENCE_DIR/images/controller.json")"
  AGENT_IMAGE="$(image_id_from_file "$EVIDENCE_DIR/images/agent.json")"
  USER_IMAGE="$(image_id_from_file "$EVIDENCE_DIR/images/user.json")"
  FIXTURE_IMAGE="$(image_id_from_file "$EVIDENCE_DIR/images/fixture.json")"
  CLIENT_IMAGE="$(image_id_from_file "$EVIDENCE_DIR/images/client.json")"
  export BUILD_IMAGE CONTROLLER_IMAGE AGENT_IMAGE USER_IMAGE FIXTURE_IMAGE CLIENT_IMAGE
}

record_outer_baseline() {
  host_docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Labels}}' | sort > "$EVIDENCE_DIR/runtime/outer-containers-before.txt"
  host_docker volume ls --format '{{.Name}}\t{{.Labels}}' | sort > "$EVIDENCE_DIR/runtime/outer-volumes-before.txt"
  host_docker network ls --format '{{.ID}}\t{{.Name}}\t{{.Labels}}' | sort > "$EVIDENCE_DIR/runtime/outer-networks-before.txt"
}

start_dind() {
  RUN_ID="issue235-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  DIND_NAME="moat-clean235-dind-${RUN_ID}"
  DIND_VOLUME="${DIND_NAME}-data"
  NETWORK_NAME="moat-clean235-${RUN_ID}"
  PROFILE_SOURCE_PATH="/data/profile"
  EMPTY_PROFILE_PATH="/data/empty"
  PROFILES_WORK_PATH="/data/profiles"
  CONTROLLER_HOST_PORT="$(pick_tcp_port)"
  NEKO_HOST_PORT="$(pick_tcp_port)"
  FIXTURE_HOST_PORT="$(pick_tcp_port)"
  UDP_BASE="$(pick_udp_base)"
  UDP_END=$((UDP_BASE + 100))
  DIND_PORT="$(pick_tcp_port)"
  INNER_DOCKER_HOST="tcp://127.0.0.1:${DIND_PORT}"
  export RUN_ID DIND_NAME DIND_VOLUME NETWORK_NAME PROFILE_SOURCE_PATH EMPTY_PROFILE_PATH PROFILES_WORK_PATH
  export INNER_DOCKER_HOST DIND_PORT CONTROLLER_HOST_PORT NEKO_HOST_PORT FIXTURE_HOST_PORT UDP_BASE UDP_END

  record_outer_baseline
  STATE_LOADED=1
  printf '%s\n' "$DIND_PLATFORM" > "$EVIDENCE_DIR/runtime/dind-platform.txt"
  host_docker volume create --label "moat.clean235.run=${RUN_ID}" "$DIND_VOLUME" > "$EVIDENCE_DIR/runtime/dind-volume.txt"
  host_docker run --platform "$DIND_PLATFORM" --privileged --detach \
    --name "$DIND_NAME" \
    --label "moat.clean235.run=${RUN_ID}" --label "moat.clean235.role=dind" \
    --volume "$DIND_VOLUME:/var/lib/docker" \
    --publish "127.0.0.1:${DIND_PORT}:2375/tcp" \
    --publish "127.0.0.1:${CONTROLLER_HOST_PORT}:3000/tcp" \
    --publish "127.0.0.1:${NEKO_HOST_PORT}:8080/tcp" \
    --publish "127.0.0.1:${FIXTURE_HOST_PORT}:8081/tcp" \
    --publish "127.0.0.1:${UDP_BASE}-${UDP_END}:${UDP_BASE}-${UDP_END}/udp" \
    --env DOCKER_TLS_CERTDIR= \
    "$DIND_IMAGE" --storage-driver=overlay2 > "$EVIDENCE_DIR/runtime/dind-id.txt"
  wait_for "inner Docker daemon" 90 inner_docker info
  inner_docker network create --label "moat.clean235.run=${RUN_ID}" "$NETWORK_NAME" >/dev/null
  host_docker exec "$DIND_NAME" sh -c 'mkdir -p /data/profile /data/empty /data/profiles && chmod 0777 /data/profile /data/empty /data/profiles'
  host_docker exec "$DIND_NAME" sh -c 'touch /data/profile/.clean-container-profile /data/empty/.clean-container-empty'
}

record_inner_baseline() {
  inner_docker info > "$EVIDENCE_DIR/runtime/inner-before-build-info.txt"
  inner_docker ps -a -q > "$EVIDENCE_DIR/runtime/inner-before-build-containers.txt"
  inner_docker image ls -q > "$EVIDENCE_DIR/runtime/inner-before-build-images.txt"
  inner_docker volume ls -q > "$EVIDENCE_DIR/runtime/inner-before-build-volumes.txt"
  inner_docker network ls --no-trunc > "$EVIDENCE_DIR/runtime/inner-before-build-networks.txt"
  inner_docker system df --format '{{json .}}' > "$EVIDENCE_DIR/runtime/inner-before-build-system-df.jsonl"
  inner_docker builder du --format '{{json .}}' > "$EVIDENCE_DIR/runtime/inner-before-build-cache.jsonl"
  host_docker inspect "$DIND_NAME" --format '{{json .}}' > "$EVIDENCE_DIR/runtime/dind-initial-inspect.json"
  python3 \
    "$EVIDENCE_DIR/runtime/inner-before-build-containers.txt" \
    "$EVIDENCE_DIR/runtime/inner-before-build-images.txt" \
    "$EVIDENCE_DIR/runtime/inner-before-build-volumes.txt" \
    "$EVIDENCE_DIR/runtime/inner-before-build-cache.jsonl" \
    "$EVIDENCE_DIR/runtime/dind-initial-inspect.json" <<'PY'
import json
import pathlib
import sys

for path in map(pathlib.Path, sys.argv[1:5]):
    if path.read_text().strip():
        raise SystemExit(f"inner Docker is not clean before cold build: {path}")
value = json.loads(pathlib.Path(sys.argv[5]).read_text())
if isinstance(value, list):
    value = value[0]
mounts = value.get("Mounts", [])
binds = value.get("HostConfig", {}).get("Binds", []) or []
if any(mount.get("Destination") == "/var/run/docker.sock" for mount in mounts):
    raise SystemExit("outer Docker socket is mounted into the isolated daemon")
if any("/var/run/docker.sock" in item for item in binds):
    raise SystemExit("outer Docker socket bind is present on the isolated daemon")
PY
}
start_fixture() {
  inner_docker run --detach --platform linux/amd64 \
    --name "${RUN_ID}-fixture" --hostname fixture --network "$NETWORK_NAME" --network-alias fixture \
    --label "moat.clean235.run=${RUN_ID}" --label "moat.clean235.role=fixture" \
    --publish "0.0.0.0:8081:8080/tcp" \
    --env PORT=8080 --env "MOAT_FIXTURE_USERNAME=${FIXTURE_USERNAME}" \
    --env "MOAT_FIXTURE_PASSWORD=${FIXTURE_PASSWORD}" --env "MOAT_FIXTURE_IDENTITY=${FIXTURE_IDENTITY}" \
    "$FIXTURE_IMAGE" >/dev/null
  wait_inner_http "${RUN_ID}-fixture" "http://127.0.0.1:8080/healthz"
  wait_for "fixture host HTTP" 90 bash -c "curl -fsS --max-time 3 http://127.0.0.1:${FIXTURE_HOST_PORT}/healthz >/dev/null"
}

start_user() {
  inner_docker run --detach --platform linux/amd64 \
    --name "${RUN_ID}-user-chrome" --hostname user-chrome --network "$NETWORK_NAME" --network-alias user-chrome \
    --label "moat.clean235.run=${RUN_ID}" --label "moat.clean235.role=user-chrome" \
    --shm-size 2g --cap-add SYS_ADMIN \
    --publish "0.0.0.0:8080:8080/tcp" \
    --publish "0.0.0.0:${UDP_BASE}-${UDP_END}:${UDP_BASE}-${UDP_END}/udp" \
    --volume "${PROFILE_SOURCE_PATH}:/home/neko/.config/chromium" \
    --env NEKO_DESKTOP_SCREEN="1920x1080@30" \
    --env "NEKO_MEMBER_MULTIUSER_USER_PASSWORD=${NEKO_USER_PASSWORD}" \
    --env "NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${NEKO_ADMIN_PASSWORD}" \
    --env "NEKO_WEBRTC_EPR=${UDP_BASE}-${UDP_END}" --env NEKO_WEBRTC_ICELITE=1 \
    --env NEKO_WEBRTC_NAT1TO1=127.0.0.1 \
    "$USER_IMAGE" >/dev/null
  wait_for "neko HTTP" 90 bash -c "curl -fsS --max-time 3 http://127.0.0.1:${NEKO_HOST_PORT}/ >/dev/null"
}


start_controller() {
  local idle_timeout="$1"
  inner_docker rm -f "${RUN_ID}-controller" >/dev/null 2>&1 || true
  inner_docker run --detach --platform linux/amd64 \
    --name "${RUN_ID}-controller" --hostname controller --network "$NETWORK_NAME" --network-alias controller \
    --label "moat.clean235.run=${RUN_ID}" --label "moat.clean235.role=controller" \
    --publish "0.0.0.0:3000:3000/tcp" \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume "${PROFILE_SOURCE_PATH}:${PROFILE_SOURCE_PATH}:ro" \
    --volume "${EMPTY_PROFILE_PATH}:${EMPTY_PROFILE_PATH}:ro" \
    --volume "${PROFILES_WORK_PATH}:${PROFILES_WORK_PATH}" \
    --env PORT=3000 --env "PROFILE_SOURCE=${PROFILE_SOURCE_PATH}" --env "PROFILES_WORK=${PROFILES_WORK_PATH}" \
    --env "PROFILES_HOST_PATH=${PROFILES_WORK_PATH}" --env "DOCKER_NETWORK=${NETWORK_NAME}" \
    --env "AGENT_CHROME_IMAGE=${AGENT_IMAGE}" \
    --env "SESSION_IDLE_TIMEOUT=${idle_timeout}" \
    "$CONTROLLER_IMAGE" >/dev/null
  wait_for "Controller TCP" 90 bash -c "python3 - <<'PY'
import socket
with socket.create_connection(('127.0.0.1', ${CONTROLLER_HOST_PORT}), 3):
    pass
PY"
  runtime_identity "${RUN_ID}-controller" "$EVIDENCE_DIR/runtime/controller-${idle_timeout}.json"
}

write_state() {
  umask 077
  cat > "$EVIDENCE_DIR/state.env" <<EOF
STATE_VERSION=1
RUN_ID=$(printf '%q' "$RUN_ID")
SOURCE_COMMIT=$(printf '%q' "$SOURCE_COMMIT")
EVIDENCE_DIR=$(printf '%q' "$EVIDENCE_DIR")
DIND_NAME=$(printf '%q' "$DIND_NAME")
DIND_VOLUME=$(printf '%q' "$DIND_VOLUME")
DIND_PLATFORM=$(printf '%q' "$DIND_PLATFORM")
DIND_PORT=$(printf '%q' "$DIND_PORT")
INNER_DOCKER_HOST=$(printf '%q' "$INNER_DOCKER_HOST")
NETWORK_NAME=$(printf '%q' "$NETWORK_NAME")
PROFILE_SOURCE_PATH=$(printf '%q' "$PROFILE_SOURCE_PATH")
EMPTY_PROFILE_PATH=$(printf '%q' "$EMPTY_PROFILE_PATH")
PROFILES_WORK_PATH=$(printf '%q' "$PROFILES_WORK_PATH")
CONTROLLER_HOST_PORT=$(printf '%q' "$CONTROLLER_HOST_PORT")
NEKO_HOST_PORT=$(printf '%q' "$NEKO_HOST_PORT")
FIXTURE_HOST_PORT=$(printf '%q' "$FIXTURE_HOST_PORT")
UDP_BASE=$(printf '%q' "$UDP_BASE")
UDP_END=$(printf '%q' "$UDP_END")
BUILD_IMAGE=$(printf '%q' "$BUILD_IMAGE")
CONTROLLER_IMAGE=$(printf '%q' "$CONTROLLER_IMAGE")
AGENT_IMAGE=$(printf '%q' "$AGENT_IMAGE")
USER_IMAGE=$(printf '%q' "$USER_IMAGE")
FIXTURE_IMAGE=$(printf '%q' "$FIXTURE_IMAGE")
CLIENT_IMAGE=$(printf '%q' "$CLIENT_IMAGE")
CLI_SHA256=$(printf '%q' "$CLI_SHA256")
FIXTURE_IDENTITY=$(printf '%q' "$FIXTURE_IDENTITY")
EOF
  chmod 0600 "$EVIDENCE_DIR/state.env"
}


write_browser_session() {
  umask 077
  python3 - "$EVIDENCE_DIR/browser-session.json" "$RUN_ID" "$SOURCE_COMMIT" "$NEKO_URL" "$FIXTURE_LOGIN_URL" "$FIXTURE_PRIVATE_URL" "$FIXTURE_HEALTH_URL" "$FIXTURE_IDENTITY" "$PROFILE_SOURCE_PATH" "$EMPTY_PROFILE_PATH" "$PROFILES_WORK_PATH" <<'PY'
import json
import pathlib
import sys
path, run_id, source_commit, neko_url, login_url, private_url, health_url, identity, profile, empty, copies = sys.argv[1:]
pathlib.Path(path).write_text(json.dumps({
  "runId": run_id,
  "sourceCommit": source_commit,
  "nekoUrl": neko_url,
  "fixtureLoginUrl": login_url,
  "fixturePrivateUrl": private_url,
  "fixtureHealthUrl": health_url,
  "fixtureIdentity": identity,
  "profileSource": profile,
  "emptyProfile": empty,
  "profileCopyWork": copies,
  "steps": [
    "Open nekoUrl in a real browser and authenticate with the generated neko user credential from fixture-secrets.env.",
    "Open fixtureLoginUrl in the user browser, fill #username and #password with fixture credentials, submit #login, and record screenshots.",
    "Confirm /private shows #auth-state data-auth-state=authenticated and data-authenticated-user=fixtureIdentity.",
    "Stop and restart user-chrome with the same profileSource; confirm /private remains authenticated.",
    "Run this script with --phase finish; it checks fixture observations, profile bridge, and the empty-profile 401 path."
  ]
}, indent=2, sort_keys=True) + "\n")
PY
  chmod 0600 "$EVIDENCE_DIR/browser-session.json"
}


start_runtime() {
  prepare_source
  write_fixture_secrets
  start_dind
  record_inner_baseline
  build_all
  start_fixture
  start_user
  start_controller 600000
  NEKO_URL="http://127.0.0.1:${NEKO_HOST_PORT}"
  FIXTURE_HOST_URL="http://127.0.0.1:${FIXTURE_HOST_PORT}"
  FIXTURE_LOGIN_URL="http://fixture:8080/login"
  FIXTURE_PRIVATE_URL="http://fixture:8080/private"
  FIXTURE_HEALTH_URL="${FIXTURE_HOST_URL}/healthz"
  export NEKO_URL FIXTURE_HOST_URL FIXTURE_LOGIN_URL FIXTURE_PRIVATE_URL FIXTURE_HEALTH_URL
  write_state
  write_browser_session
  record_inner_info
  inner_docker ps -a --no-trunc > "$EVIDENCE_DIR/runtime/inner-after-start.txt"
}

run_client() {
  local kind="$1"
  local result_dir="$2"
  local name="${RUN_ID}-client-${kind}"
  local wait_log="$LOG_DIR/client-${kind}-wait.log"
  rm -rf "$result_dir"
  mkdir -p "$result_dir"
  inner_docker rm -f "$name" >/dev/null 2>&1 || true
  set +e
  inner_docker run --detach --platform linux/amd64 \
    --name "$name" --hostname "client-${kind}" --network "$NETWORK_NAME" \
    --label "moat.clean235.run=${RUN_ID}" --label "moat.clean235.role=client" \
    --env "MOAT_CONTROLLER=ws://controller:3000" \
    --env "FIXTURE_URL=http://fixture:8080" \
    --env "MATRIX_FIXTURE_URL=https://example.com/" \
    --env "RESULT_DIR=/work/results" \
    --env "SOURCE_COMMIT=${SOURCE_COMMIT}" \
    --env "MOAT_INSTALL_SHA256=${CLI_SHA256}" \
    --env "MOAT_FIXTURE_IDENTITY=${FIXTURE_IDENTITY}" \
    --env TEST_PROFILE=default --env EMPTY_PROFILE=empty \
    --env "RUN_KIND=${kind}" --env IDLE_SECONDS=45 \
    "$CLIENT_IMAGE" > "$LOG_DIR/client-${kind}-id.log" 2>&1
  local start_status=$?
  if [[ "$start_status" -eq 0 ]]; then
    inner_docker wait "$name" > "$wait_log" 2>&1
    local wait_cli_status=$?
    local container_exit=""
    if [[ "$wait_cli_status" -eq 0 ]]; then
      container_exit="$(tr -d '[:space:]' < "$wait_log")"
    fi
    printf '%s\n' "$container_exit" > "$result_dir/container-exit-code.txt"
    inner_docker cp "$name:/work/results/." "$result_dir/" > "$LOG_DIR/client-${kind}-cp.log" 2>&1 || true
    inner_docker logs "$name" > "$result_dir/container.log" 2>&1 || true
    runtime_identity "$name" "$result_dir/container-identity.json" || true
    inner_docker rm "$name" >/dev/null 2>&1 || true
    set -e
    if [[ "$wait_cli_status" -ne 0 ]]; then return "$wait_cli_status"; fi
    if [[ "$container_exit" != "0" ]]; then return 1; fi
  else
    set -e
    return "$start_status"
  fi
  return 0
}

fixture_observations() {
  local path="$1"
  inner_docker exec "${RUN_ID}-fixture" node -e 'fetch("http://127.0.0.1:8080/observations").then(async r=>{if(!r.ok)process.exit(1); process.stdout.write(await r.text())}).catch(()=>process.exit(1))' > "$path"
}

assert_login_observations() {
  local path="$1"
  python3 - "$path" <<'PY'
import json
import pathlib
import sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
if value.get("loginCount", 0) < 1:
    raise SystemExit("fixture has no successful login observation")
if value.get("authenticatedPrivateCount", 0) < 1:
    raise SystemExit("fixture has no authenticated private-page observation")
if value.get("lastAuthenticatedUser") != "clean-container-user":
    raise SystemExit("fixture identity observation mismatch")
PY
}
assert_report_passed() {
  local path="$1"
  [[ -f "$path" ]] || return 1
  python3 - "$path" <<'PY'
import json
import pathlib
import sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
raise SystemExit(0 if value.get("passed") is True else 1)
PY
}

stop_user_gracefully() {
  local name="${RUN_ID}-user-chrome"
  runtime_identity "$name" "$EVIDENCE_DIR/runtime/user-before-stop.json"
  if ! inner_docker exec "$name" supervisorctl status > "$EVIDENCE_DIR/runtime/user-supervisor-before-stop.log" 2>&1; then
    echo "supervisorctl status failed; refusing to treat a container stop as a clean browser stop" >&2
    return 1
  fi
  local programs
  programs="$(python3 - "$EVIDENCE_DIR/runtime/user-supervisor-before-stop.log" <<'PY'
import pathlib
import sys
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    fields = line.split()
    if len(fields) >= 2 and fields[1] in {"RUNNING", "STARTING"}:
        print(fields[0])
PY
)"
  [[ -n "$programs" ]] || {
    echo "supervisorctl reported no running managed programs" >&2
    return 1
  }
  while IFS= read -r program; do
    [[ -n "$program" ]] || continue
    inner_docker exec "$name" supervisorctl stop "$program" >> "$EVIDENCE_DIR/runtime/user-supervisor-stop.log" 2>&1 \
      || return 1
  done <<< "$programs"
  inner_docker exec "$name" supervisorctl status > "$EVIDENCE_DIR/runtime/user-supervisor-after-stop.log" 2>&1 \
    || return 1
  python3 - "$EVIDENCE_DIR/runtime/user-supervisor-after-stop.log" <<'PY'
import pathlib
import sys
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    fields = line.split()
    if len(fields) >= 2 and fields[1] in {"RUNNING", "STARTING"}:
        raise SystemExit(f"managed process remained active after supervisor stop: {fields[0]}")
PY
  inner_docker stop "$name" > "$EVIDENCE_DIR/runtime/user-stop.log"
  local state exit_code oom_killed
  state="$(inner_docker inspect "$name" --format '{{.State.Status}}')"
  exit_code="$(inner_docker inspect "$name" --format '{{.State.ExitCode}}')"
  oom_killed="$(inner_docker inspect "$name" --format '{{.State.OOMKilled}}')"
  printf '%s\n' "$state" > "$EVIDENCE_DIR/runtime/user-stop-state.txt"
  printf '%s\n' "$exit_code" > "$EVIDENCE_DIR/runtime/user-stop-exit-code.txt"
  printf '%s\n' "$oom_killed" > "$EVIDENCE_DIR/runtime/user-stop-oom-killed.txt"
  [[ "$state" == exited && "$exit_code" == 0 && "$oom_killed" == false ]] || return 1
  runtime_identity "$name" "$EVIDENCE_DIR/runtime/user-after-stop.json"
}

reset_second_runtime() {
  local old_network="$NETWORK_NAME"
  inner_docker ps -aq > "$EVIDENCE_DIR/runtime/second-owned-before.txt"
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    inner_docker rm -f "$id" >> "$EVIDENCE_DIR/runtime/second-remove.log" 2>&1
  done < "$EVIDENCE_DIR/runtime/second-owned-before.txt"
  inner_docker ps -aq > "$EVIDENCE_DIR/runtime/second-owned-after.txt"
  [[ ! -s "$EVIDENCE_DIR/runtime/second-owned-after.txt" ]] || die "first runtime session containers remained before row-8 recreation"
  if inner_docker network inspect "$old_network" >/dev/null 2>&1; then
    inner_docker network rm "$old_network" > "$EVIDENCE_DIR/runtime/second-network-remove.log" 2>&1
  fi
  if inner_docker network inspect "$old_network" >/dev/null 2>&1; then
    die "first runtime network remained before row-8 recreation"
  fi
  printf '%s\n' "$old_network" > "$EVIDENCE_DIR/runtime/second-old-network-removed.txt"
  PROFILE_SOURCE_PATH="/data/profile-second"
  EMPTY_PROFILE_PATH="/data/empty-second"
  PROFILES_WORK_PATH="/data/profiles-second"
  NETWORK_NAME="${RUN_ID}-second"
  export PROFILE_SOURCE_PATH EMPTY_PROFILE_PATH PROFILES_WORK_PATH NETWORK_NAME
  host_docker exec "$DIND_NAME" sh -c \
    'rm -rf /data/profile-second /data/empty-second /data/profiles-second && mkdir -p /data/profile-second /data/empty-second /data/profiles-second && chmod 0777 /data/profile-second /data/empty-second /data/profiles-second && touch /data/profile-second/.clean-container-profile /data/empty-second/.clean-container-empty'
  inner_docker network create --label "moat.clean235.run=${RUN_ID}" "$NETWORK_NAME" >/dev/null
  start_fixture
  start_controller 600000
  write_state
  inner_docker ps -a --no-trunc > "$EVIDENCE_DIR/runtime/inner-after-second-reset.txt"
}


cleanup_owned() {
  [[ "${STATE_LOADED:-0}" -eq 1 ]] || return 0
  local cleanup_ok=1
  CLEANUP_OK=0
  set +e
  mkdir -p "$EVIDENCE_DIR/cleanup"
  inner_docker ps -a --no-trunc > "$EVIDENCE_DIR/cleanup/inner-owned-before.txt" 2>&1
  inner_docker ps -aq > "$EVIDENCE_DIR/cleanup/inner-owned-before-ids.txt" 2>&1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    inner_docker rm -f "$id" >> "$EVIDENCE_DIR/cleanup/inner-sweep.log" 2>&1 || cleanup_ok=0
  done < "$EVIDENCE_DIR/cleanup/inner-owned-before-ids.txt"
  if inner_docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    inner_docker network rm "$NETWORK_NAME" > "$EVIDENCE_DIR/cleanup/network-remove.log" 2>&1 || cleanup_ok=0
  fi
  inner_docker ps -a --no-trunc > "$EVIDENCE_DIR/cleanup/inner-after.txt" 2>&1
  inner_docker ps -aq > "$EVIDENCE_DIR/cleanup/inner-owned-leftovers.txt" 2>&1
  [[ ! -s "$EVIDENCE_DIR/cleanup/inner-owned-leftovers.txt" ]] || cleanup_ok=0
  if inner_docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then cleanup_ok=0; fi
  host_docker exec "$DIND_NAME" sh -c 'find /data -maxdepth 2 -type f -print | sort' > "$EVIDENCE_DIR/cleanup/profile-files-after.txt" 2>&1 || cleanup_ok=0
  host_docker inspect "$DIND_NAME" --format '{{json .}}' > "$EVIDENCE_DIR/cleanup/dind-inspect-before-remove.json" 2>&1 || true
  if host_docker inspect "$DIND_NAME" >/dev/null 2>&1; then
    host_docker rm -f "$DIND_NAME" > "$EVIDENCE_DIR/cleanup/dind-remove.log" 2>&1 || cleanup_ok=0
  fi
  if host_docker inspect "$DIND_NAME" >/dev/null 2>&1; then cleanup_ok=0; fi
  host_docker volume inspect "$DIND_VOLUME" --format '{{json .}}' > "$EVIDENCE_DIR/cleanup/dind-volume-before-remove.json" 2>&1 || true
  if host_docker volume inspect "$DIND_VOLUME" >/dev/null 2>&1; then
    host_docker volume rm "$DIND_VOLUME" > "$EVIDENCE_DIR/cleanup/dind-volume-remove.txt" 2>&1 || true
    for _ in 1 2 3 4 5; do
      host_docker volume inspect "$DIND_VOLUME" >/dev/null 2>&1 || break
      sleep 1
      host_docker volume rm "$DIND_VOLUME" >> "$EVIDENCE_DIR/cleanup/dind-volume-remove.txt" 2>&1 || true
    done
  fi
  if host_docker volume inspect "$DIND_VOLUME" >/dev/null 2>&1; then cleanup_ok=0; fi
  host_docker ps -a --no-trunc > "$EVIDENCE_DIR/cleanup/outer-after.txt" 2>&1
  host_docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Labels}}' | sort > "$EVIDENCE_DIR/cleanup/outer-containers-after.txt" 2>&1
  host_docker volume ls --format '{{.Name}}\t{{.Labels}}' | sort > "$EVIDENCE_DIR/cleanup/outer-volumes-after.txt" 2>&1
  host_docker network ls --format '{{.ID}}\t{{.Name}}\t{{.Labels}}' | sort > "$EVIDENCE_DIR/cleanup/outer-networks-after.txt" 2>&1
  python3 \
    "$EVIDENCE_DIR/runtime/outer-containers-before.txt" \
    "$EVIDENCE_DIR/cleanup/outer-containers-after.txt" \
    "$EVIDENCE_DIR/runtime/outer-volumes-before.txt" \
    "$EVIDENCE_DIR/cleanup/outer-volumes-after.txt" \
    "$EVIDENCE_DIR/runtime/outer-networks-before.txt" \
    "$EVIDENCE_DIR/cleanup/outer-networks-after.txt" \
    > "$EVIDENCE_DIR/cleanup/outer-inventory-compare.txt" 2>&1 <<'PY' || cleanup_ok=0
import pathlib
import sys
for before, after in zip(sys.argv[1::2], sys.argv[2::2]):
    if pathlib.Path(before).read_text() != pathlib.Path(after).read_text():
        raise SystemExit(f"outer inventory changed: {before} -> {after}")
print("outer container, volume, and network inventories unchanged")
PY
  python3 - "$EVIDENCE_DIR/cleanup/result.json" "$cleanup_ok" <<'PY'
import json
import pathlib
import sys
passed = sys.argv[2] == "1"
pathlib.Path(sys.argv[1]).write_text(json.dumps({"passed": passed}, indent=2) + "\n")
PY
CLEANUP_OK="$cleanup_ok"
STATE_LOADED=0
  set -e
  return 0
}

write_summary() {
  local mode="$1" row4="$2" row5="$3" row6="$4" row7="$5" row8="$6" state="$7"
  python3 - "$EVIDENCE_DIR/summary.json" "$mode" "$row4" "$row5" "$row6" "$row7" "$row8" "$state" <<'PY'
import json
import pathlib
import sys
summary, mode, row4, row5, row6, row7, row8, state = sys.argv[1:]
root = pathlib.Path(summary).parent
source = root / "source"
build = root / "build"
def status(value):
    return "pass" if value == "pass" else ("fail" if value == "fail" else "blocked")
rows = [
  {"row": 1, "dimension": "environment", "status": "pass", "evidence": ["source/commit.txt", "source/tree.txt", "runtime/outer-docker-info.txt", "runtime/inner-docker-info.txt"]},
  {"row": 2, "dimension": "integration", "status": "pass", "evidence": ["build/toolchain-versions.txt", "build/generated-files.txt", "build/moat-x86_64-linux.sha256", "rawlogs/build-build.log"]},
  {"row": 3, "dimension": "integration", "status": "pass", "evidence": ["images/controller.json", "images/agent.json", "images/user.json", "images/fixture.json", "images/base-identities.json", "rawlogs/build-controller.log", "rawlogs/build-agent.log", "rawlogs/build-user.log", "rawlogs/build-fixture.log"]},
  {"row": 4, "dimension": "integration", "status": status(row4), "evidence": ["client/normal/client-identity.json", "client/normal/installer-invalid.log", "client/normal/installer.log", "client/normal/basic/summary.json"]},
  {"row": 5, "dimension": "integration", "status": status(row5), "evidence": ["browser-session.json", "runtime/user-before-restart.json", "runtime/user-after-restart.json", "runtime/user-restart-observation-times.txt", "runtime/fixture-observations-before-user-restart.json", "runtime/fixture-observations-after-user-restart.json", "runtime/fixture-observations-before.json", "runtime/fixture-observations-after-normal.json", "cleanup/profile-files-after.txt"]},
  {"row": 6, "dimension": "integration", "status": status(row6), "evidence": ["client/normal/matrix/summary.json", "client/normal/matrix/cli-all-commands-results.json"]},
  {"row": 7, "dimension": "integration", "status": status(row7), "evidence": ["client/normal/replay-normal/row7-replay-normal.json", "client/idle/replay-idle/row7-replay-idle.json", "client/idle/replay-idle/row7-replay-idle.jsonl"]},
  {"row": 8, "dimension": "integration", "status": status(row8), "evidence": ["client/second/basic/summary.json", "cleanup/inner-after.txt", "cleanup/profile-files-after.txt", "cleanup/outer-after.txt", "cleanup/result.json"]},
]
identity = {}
for name in ("controller", "agent", "user", "fixture", "client"):
    path = root / "images" / f"{name}.json"
    if path.exists():
        identity[name] = json.loads(path.read_text())
cli_sha = None
sha_path = build / "moat-x86_64-linux.sha256"
if sha_path.exists():
    cli_sha = sha_path.read_text().split()[0]
source_commit = (source / "commit.txt").read_text().splitlines()[0] if (source / "commit.txt").exists() else None
pathlib.Path(summary).write_text(json.dumps({
  "mode": mode,
  "state": state,
  "sourceCommit": source_commit,
  "rows": rows,
  "artifacts": {
    "cliSha256": cli_sha,
    "images": identity,
    "baseIdentityFile": "images/base-identities.json",
    "baseIdentityText": "images/base-identities.txt",
    "dindPlatform": "runtime/dind-platform.txt",
    "dindVolume": "runtime/dind-volume.txt",
  },
  "cleanupOwned": ["DinD container", "DinD data volume", "inner network", "fixture", "user-chrome", "Controller", "agent-chrome session containers", "client containers", "profile copies under /data"],
  "evidenceRoot": str(root),
}, indent=2, sort_keys=True) + "\n")
PY
}


restart_user_phase() {
  load_state
  record_outer_preflight
  write_fixture_secrets
  # shellcheck disable=SC1090
  source "$EVIDENCE_DIR/fixture-secrets.env"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$EVIDENCE_DIR/runtime/user-restart-observation-times.txt"
  fixture_observations "$EVIDENCE_DIR/runtime/fixture-observations-before-user-restart.json"
  runtime_identity "${RUN_ID}-user-chrome" "$EVIDENCE_DIR/runtime/user-before-restart.json"
  stop_user_gracefully
  printf 'stopped=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$EVIDENCE_DIR/runtime/user-restart-observation-times.txt"
  inner_docker rm "${RUN_ID}-user-chrome" > "$EVIDENCE_DIR/runtime/user-remove.log"
  start_user
  runtime_identity "${RUN_ID}-user-chrome" "$EVIDENCE_DIR/runtime/user-after-restart.json"
  fixture_observations "$EVIDENCE_DIR/runtime/fixture-observations-after-user-restart.json"
  printf 'afterRestart=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$EVIDENCE_DIR/runtime/user-restart-observation-times.txt"
  python3 \
    "$EVIDENCE_DIR/runtime/fixture-observations-before-user-restart.json" \
    "$EVIDENCE_DIR/runtime/fixture-observations-after-user-restart.json" <<'PY'
import json
import pathlib
import sys
before = json.loads(pathlib.Path(sys.argv[1]).read_text())
after = json.loads(pathlib.Path(sys.argv[2]).read_text())
if after.get("loginCount") != before.get("loginCount"):
    raise SystemExit("successful-login count changed during restart without browser revisit")
if after.get("authenticatedPrivateCount") != before.get("authenticatedPrivateCount"):
    raise SystemExit("authenticated-private count changed during restart without browser revisit")
PY
  echo "$EVIDENCE_DIR"
}

prepare_phase() {
  record_outer_preflight

  start_runtime
  write_summary prepare blocked blocked blocked blocked blocked awaiting-browser-login
  echo "Prepared issue-235 runtime. Open $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["nekoUrl"])' "$EVIDENCE_DIR/browser-session.json") and follow $EVIDENCE_DIR/browser-session.json" >&2
  echo "$EVIDENCE_DIR"
}

finish_phase() {
  load_state
  record_outer_preflight
  write_fixture_secrets
  # shellcheck disable=SC1090
  source "$EVIDENCE_DIR/fixture-secrets.env"
  SOURCE_DIR="$EVIDENCE_DIR/source/source"
  export SOURCE_DIR
  local row4=pass row5=pass row6=pass row7=pass row8=pass
  if ! fixture_observations "$EVIDENCE_DIR/runtime/fixture-observations-before.json"; then
    row4=fail
    row5=fail
  elif ! assert_login_observations "$EVIDENCE_DIR/runtime/fixture-observations-before.json"; then
    row4=fail
    row5=fail
  elif ! python3 \
    "$EVIDENCE_DIR/runtime/fixture-observations-before-user-restart.json" \
    "$EVIDENCE_DIR/runtime/fixture-observations-after-user-restart.json" \
    "$EVIDENCE_DIR/runtime/fixture-observations-before.json" <<'PY'
import json
import pathlib
import sys
restart_before, restart_after, finish_before = [
    json.loads(pathlib.Path(path).read_text()) for path in sys.argv[1:]
]
if restart_after.get("loginCount") != restart_before.get("loginCount"):
    raise SystemExit("login count changed during restart")
if restart_after.get("authenticatedPrivateCount") != restart_before.get("authenticatedPrivateCount"):
    raise SystemExit("authenticated-private count changed during restart")
if finish_before.get("loginCount") != restart_after.get("loginCount"):
    raise SystemExit("login count changed after restart without a new login")
if finish_before.get("authenticatedPrivateCount", 0) <= restart_after.get("authenticatedPrivateCount", 0):
    raise SystemExit("post-restart /private observation did not increase before finish")
PY
  then
    row5=fail
  fi
  if [[ ! -f "$EVIDENCE_DIR/runtime/user-after-restart.json" ]]; then
    row5=fail
  fi
  if ! stop_user_gracefully; then
    row5=fail
  fi
  if [[ "$row5" != pass ]]; then
    cleanup_owned
    write_summary finish "$row4" "$row5" blocked blocked blocked restart-profile-proof-missing
    echo "$EVIDENCE_DIR"
    exit 1
  fi
  if ! run_client normal "$EVIDENCE_DIR/client/normal"; then row4=fail; fi
  if ! assert_report_passed "$EVIDENCE_DIR/client/normal/basic/summary.json"; then
    row4=fail
    row5=fail
  fi
  if ! fixture_observations "$EVIDENCE_DIR/runtime/fixture-observations-after-normal.json"; then
    row5=fail
  elif ! python3 - "$EVIDENCE_DIR/runtime/fixture-observations-after-normal.json" <<'PY'
import json
import pathlib
import sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
raise SystemExit(0 if value.get("authenticatedPrivateCount", 0) >= 1 and value.get("loggedOutPrivateCount", 0) >= 1 else 1)
PY
  then
    row5=fail
  fi
  if ! assert_report_passed "$EVIDENCE_DIR/client/normal/matrix/summary.json"; then row6=fail; fi
  if ! assert_report_passed "$EVIDENCE_DIR/client/normal/replay-normal/row7-replay-normal.json"; then row7=fail; fi

  if ! start_controller 10000; then row7=fail; fi
  if ! run_client idle "$EVIDENCE_DIR/client/idle"; then row7=fail; fi
  if ! assert_report_passed "$EVIDENCE_DIR/client/idle/replay-idle/row7-replay-idle.json"; then row7=fail; fi

  if ! reset_second_runtime; then
    row8=fail
  else
    if ! run_client second "$EVIDENCE_DIR/client/second"; then row8=fail; fi
    if ! assert_report_passed "$EVIDENCE_DIR/client/second/basic/summary.json"; then row8=fail; fi
    if ! fixture_observations "$EVIDENCE_DIR/runtime/fixture-observations-final.json"; then
      row8=fail
    elif ! python3 - "$EVIDENCE_DIR/runtime/fixture-observations-final.json" <<'PY'
import json
import pathlib
import sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
raise SystemExit(0 if value.get("authenticatedPrivateCount", 0) == 0 and value.get("loggedOutPrivateCount", 0) >= 1 else 1)
PY
    then
      row8=fail
    fi
  fi
  cleanup_owned
  [[ "$CLEANUP_OK" -eq 1 ]] || row8=fail
  local final_state=complete
  for value in "$row4" "$row5" "$row6" "$row7" "$row8"; do
    [[ "$value" == pass ]] || final_state=failed
  done
  write_summary finish "$row4" "$row5" "$row6" "$row7" "$row8" "$final_state"
  echo "$EVIDENCE_DIR"
  [[ "$final_state" == complete ]]
}

if [[ "$PHASE" == prepare ]]; then
  trap 'if [[ "$KEEP_RUNTIME" -ne 1 && "$STATE_LOADED" -eq 1 ]]; then cleanup_owned; fi' EXIT
  prepare_phase
  KEEP_RUNTIME=1
elif [[ "$PHASE" == restart-user ]]; then
  trap 'if [[ "$KEEP_RUNTIME" -ne 1 && "$STATE_LOADED" -eq 1 ]]; then cleanup_owned; fi' EXIT
  restart_user_phase
  KEEP_RUNTIME=1
else
  trap cleanup_owned EXIT
  finish_phase
fi
