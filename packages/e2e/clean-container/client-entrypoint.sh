#!/usr/bin/env bash
set -Eeuo pipefail

: "${MOAT_CONTROLLER:?MOAT_CONTROLLER must target this run's Controller}"
: "${FIXTURE_URL:?FIXTURE_URL must target this run's fixture}"
: "${RESULT_DIR:?RESULT_DIR must be a mounted or ephemeral evidence path}"
: "${SOURCE_COMMIT:?SOURCE_COMMIT must identify the fixed checkout}"
: "${MOAT_INSTALL_SHA256:?MOAT_INSTALL_SHA256 must identify the candidate asset}"

readonly INSTALLER=/opt/moat-source/scripts/install.sh
readonly ASSET=/input/moat-x86_64-linux
readonly ASSET_SHA_FILE=/input/moat-x86_64-linux.sha256
readonly INSTALL_DIR=/work/bin
readonly OBSERVER_ROOT=/work/installer-observer
readonly OBSERVER_BIN="$OBSERVER_ROOT/bin"
readonly OBSERVER_MARKER="$OBSERVER_ROOT/gh-invoked"

die() {
  echo "clean client: $*" >&2
  exit 1
}

mkdir -p "$RESULT_DIR" /work/home "$INSTALL_DIR" "$OBSERVER_BIN" /work/installer-negative
export HOME=/work/home
export MOAT_INSTALL_ASSET="$ASSET"
export MOAT_INSTALL_DIR="$INSTALL_DIR"
export MOAT="$INSTALL_DIR/moat"
export PATH="$INSTALL_DIR:${PATH}"

if [[ -e "$MOAT" ]]; then
  die "candidate client started with a pre-installed moat binary"
fi
if [[ -e "$HOME/.moat/session" ]]; then
  die "candidate client started with an existing session"
fi
[[ -r "$ASSET" ]] || die "candidate asset is not readable: $ASSET"
[[ -r "$ASSET_SHA_FILE" ]] || die "candidate asset checksum file is not readable: $ASSET_SHA_FILE"
[[ -x "$INSTALLER" ]] || die "candidate installer is not executable: $INSTALLER"

actual_sha="$(sha256sum "$ASSET")"
actual_sha="${actual_sha%% *}"
if [[ ! "$actual_sha" =~ ^[0-9a-fA-F]{64}$ ]]; then
  die "candidate asset checksum command returned an invalid digest"
fi

python3 - "$ASSET_SHA_FILE" "$actual_sha" "$MOAT_INSTALL_SHA256" <<'PY'
import pathlib
import re
import sys

sidecar_path, actual, expected = sys.argv[1:]
lines = [line.strip() for line in pathlib.Path(sidecar_path).read_text().splitlines() if line.strip()]
if len(lines) != 1:
    raise SystemExit("candidate checksum file must contain exactly one non-empty line")
parts = lines[0].split()
if not parts or not re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
    raise SystemExit("candidate checksum file has no 64-character SHA-256 digest")
sidecar = parts[0].lower()
if sidecar != actual.lower() or sidecar != expected.lower():
    raise SystemExit("candidate asset, checksum file, and configured SHA-256 do not match")
PY

cat > "$OBSERVER_BIN/gh" <<'SH'
#!/bin/sh
set -eu
: "${MOAT_INSTALL_OBSERVER_MARKER:?observer marker is required}"
printf '%s\n' gh-invoked > "$MOAT_INSTALL_OBSERVER_MARKER"
exit 97
SH
chmod 0755 "$OBSERVER_BIN/gh"
observer_path="$OBSERVER_BIN:${PATH}"

assert_negative_installer() {
  local name="$1" mode="$2"
  shift 2
  local case_dir="/work/installer-negative/$name"
  local log="$RESULT_DIR/installer-${name}.log"
  rm -rf "$case_dir"
  mkdir -p "$case_dir"
  printf '%s\n' "clean-client-installer-sentinel-${name}" > "$case_dir/moat"
  chmod 0755 "$case_dir/moat"
  local sentinel_sha
sentinel_sha="$(sha256sum "$case_dir/moat")"
sentinel_sha="${sentinel_sha%% *}"
  rm -f "$OBSERVER_MARKER"

  local code
  set +e
  case "$mode" in
    cli)
      env -u MOAT_INSTALL_ASSET -u MOAT_INSTALL_SHA256 \
        MOAT_INSTALL_DIR="$case_dir" \
        MOAT_INSTALL_OBSERVER_MARKER="$OBSERVER_MARKER" \
        PATH="$observer_path" \
        bash "$INSTALLER" "$@" >"$log" 2>&1
      code=$?
      ;;
    env)
      env MOAT_INSTALL_ASSET= MOAT_INSTALL_SHA256= \
        MOAT_INSTALL_DIR="$case_dir" \
        MOAT_INSTALL_OBSERVER_MARKER="$OBSERVER_MARKER" \
        PATH="$observer_path" \
        bash "$INSTALLER" >"$log" 2>&1
      code=$?
      ;;
    *)
      set -e
      die "unknown negative installer test mode: $mode"
      ;;
  esac
  set -e

  if [[ "$code" -eq 0 ]]; then
    die "negative installer case unexpectedly succeeded: $name"
  fi
  if [[ -e "$OBSERVER_MARKER" ]]; then
    die "negative installer case attempted a release/network download: $name"
  fi
  local preserved_sha
preserved_sha="$(sha256sum "$case_dir/moat")"
preserved_sha="${preserved_sha%% *}"
  if [[ "$preserved_sha" != "$sentinel_sha" ]] || ! cmp -s "$case_dir/moat" <(printf '%s\n' "clean-client-installer-sentinel-${name}"); then
    die "negative installer case replaced its sentinel: $name"
  fi
}

assert_negative_installer empty-cli cli --asset "" --sha256 ""
assert_negative_installer empty-env env
assert_negative_installer missing-asset cli --sha256 "$MOAT_INSTALL_SHA256"
assert_negative_installer missing-sha cli --asset "$ASSET"
wrong_sha="$(python3 - "$actual_sha" <<'PY'
import sys
actual = sys.argv[1].lower()
print("f" * 64 if actual == "0" * 64 else "0" * 64)
PY
)"
assert_negative_installer wrong-sha cli --asset "$ASSET" --sha256 "$wrong_sha"

rm -f "$OBSERVER_MARKER"
set +e
env MOAT_INSTALL_ASSET="$ASSET" \
  MOAT_INSTALL_SHA256="$MOAT_INSTALL_SHA256" \
  MOAT_INSTALL_DIR="$INSTALL_DIR" \
  MOAT_INSTALL_OBSERVER_MARKER="$OBSERVER_MARKER" \
  PATH="$observer_path" \
  bash "$INSTALLER" --asset "$ASSET" --sha256 "$MOAT_INSTALL_SHA256" \
  >"$RESULT_DIR/installer.log" 2>&1
install_status=$?
set -e
if [[ "$install_status" -ne 0 ]]; then
  die "candidate installer failed for the exact asset (exit $install_status)"
fi
if [[ -e "$OBSERVER_MARKER" ]]; then
  die "valid candidate installer attempted a release/network download"
fi
[[ -x "$MOAT" ]] || die "candidate installer did not produce an executable moat"
installed_sha="$(sha256sum "$MOAT")"
installed_sha="${installed_sha%% *}"
if [[ "$installed_sha" != "$MOAT_INSTALL_SHA256" ]]; then
  die "installed moat checksum does not match the candidate SHA-256"
fi
if ! cmp -s "$ASSET" "$MOAT"; then
  die "installed moat bytes differ from the candidate asset"
fi

# Keep metadata generation explicit and free of environment values that may hold secrets.
python3 - "$RESULT_DIR/client-identity.json" "$SOURCE_COMMIT" "$MOAT_INSTALL_SHA256" "$installed_sha" <<'PY'
import json
import pathlib
import sys

path, source_commit, expected_sha, installed_sha = sys.argv[1:]
identity = json.loads(pathlib.Path("/opt/source-identity.json").read_text())
if identity.get("sourceCommit") != source_commit:
    raise SystemExit("source identity does not match SOURCE_COMMIT")
if identity.get("cliSha256", "").lower() != expected_sha.lower():
    raise SystemExit("source identity does not match MOAT_INSTALL_SHA256")
identity.update({"installedCliSha256": installed_sha, "moat": "/work/bin/moat"})
pathlib.Path(path).write_text(json.dumps(identity, sort_keys=True) + "\n")
PY

check_replay_report() {
  local report="$1" mode="$2"
  python3 - "$report" "$mode" <<'PY'
import json
import pathlib
import sys

report_path, mode = sys.argv[1:]
value = json.loads(pathlib.Path(report_path).read_text())
if value.get("mode") != mode or value.get("status") != "passed" or value.get("passed") is not True:
    raise SystemExit("replay report is not passed for the requested mode")
rows = value.get("rows")
if not isinstance(rows, list) or not rows or any(row.get("passed") is not True for row in rows):
    raise SystemExit("replay report contains a failed or missing row")
if any(row.get("cleanupErrors") for row in rows):
    raise SystemExit("replay report contains cleanup errors")
if value.get("failures"):
    raise SystemExit("replay report contains failures")
PY
}

kind="${RUN_KIND:-normal}"
overall_status=0
case "$kind" in
  normal)
    set +e
    /opt/harness/run-basic.sh
    basic_status=$?
    set -e
    if [[ "$basic_status" -ne 0 ]]; then
      overall_status=1
    fi

    set +e
    /opt/harness/run-matrix.sh
    matrix_status=$?
    set -e
    if [[ "$matrix_status" -ne 0 ]]; then
      overall_status=1
    fi

    replay_dir="$RESULT_DIR/replay-normal"
    mkdir -p "$replay_dir"
    set +e
    python3 /opt/moat-source/packages/e2e/clean-container/replay.py \
      --mode normal \
      --moat "$MOAT" \
      --controller "$MOAT_CONTROLLER" \
      --fixture-url "$FIXTURE_URL" \
      --evidence-dir "$replay_dir" \
      --profile "${TEST_PROFILE:-default}" \
      >"$replay_dir/stdout.log" 2>"$replay_dir/stderr.log"
    replay_status=$?
    set -e
    if [[ "$replay_status" -ne 0 ]]; then
      overall_status=1
    fi
    report="$replay_dir/row7-replay-normal.json"
    if [[ ! -f "$report" ]]; then
      overall_status=1
    else
      set +e
      check_replay_report "$report" normal
      report_status=$?
      set -e
      if [[ "$report_status" -ne 0 ]]; then
        overall_status=1
      fi
    fi
    ;;
  idle)
    idle_seconds="${IDLE_SECONDS:-45}"
    [[ "$idle_seconds" == "45" ]] || die "idle mode requires IDLE_SECONDS=45"
    replay_dir="$RESULT_DIR/replay-idle"
    mkdir -p "$replay_dir"
    set +e
    python3 /opt/moat-source/packages/e2e/clean-container/replay.py \
      --mode idle \
      --moat "$MOAT" \
      --controller "$MOAT_CONTROLLER" \
      --fixture-url "$FIXTURE_URL" \
      --evidence-dir "$replay_dir" \
      --profile "${TEST_PROFILE:-default}" \
      --idle-seconds "$idle_seconds" \
      >"$replay_dir/stdout.log" 2>"$replay_dir/stderr.log"
    replay_status=$?
    set -e
    if [[ "$replay_status" -ne 0 ]]; then
      overall_status=1
    fi
    report="$replay_dir/row7-replay-idle.json"
    if [[ ! -f "$report" ]]; then
      overall_status=1
    else
      set +e
      check_replay_report "$report" idle
      report_status=$?
      set -e
      if [[ "$report_status" -ne 0 ]]; then
        overall_status=1
      fi
    fi
    ;;
  second)
    set +e
    /opt/harness/run-basic.sh
    basic_status=$?
    set -e
    if [[ "$basic_status" -ne 0 ]]; then
      overall_status=1
    fi
    ;;
  *)
    echo "unknown RUN_KIND=${kind}" >&2
    exit 2
    ;;
esac

exit "$overall_status"
