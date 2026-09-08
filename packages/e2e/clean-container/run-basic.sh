#!/usr/bin/env bash
set -Eeuo pipefail

: "${MOAT:?MOAT must name the installed candidate binary}"
: "${MOAT_CONTROLLER:?MOAT_CONTROLLER must target this run's Controller}"
: "${FIXTURE_URL:?FIXTURE_URL must target this run's fixture}"
: "${RESULT_DIR:?RESULT_DIR must be writable evidence output}"
: "${TEST_PROFILE:=default}"
: "${EMPTY_PROFILE:=empty}"

readonly FIXTURE_ROOT="${FIXTURE_URL%/}"
readonly MODE="${RUN_KIND:-normal}"
readonly EXPECTED_IDENTITY="${MOAT_FIXTURE_IDENTITY:-clean-container-user}"

case "$MODE" in
  normal|second) ;;
  *) echo "basic scenario does not support RUN_KIND=${MODE}" >&2; exit 2 ;;
esac

LOG_DIR="$RESULT_DIR/basic"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"
FAILED=0
STEP=0
LAST_STDOUT=""

run_step() {
  local name="$1" expected="$2"
  shift 2
  STEP=$((STEP + 1))
  local stdout="$LOG_DIR/${STEP}-${name}.stdout"
  local stderr="$LOG_DIR/${STEP}-${name}.stderr"
  local meta="$LOG_DIR/${STEP}-${name}.json"
  LAST_STDOUT="$stdout"

  local code
  set +e
  "$MOAT" --json "$@" >"$stdout" 2>"$stderr"
  code=$?
  set -e

  local metadata_status
  set +e
  python3 - "$meta" "$name" "$expected" "$code" "$stdout" "$stderr" <<'PY'
import json
import pathlib
import sys

meta, name, expected, code, stdout_path, stderr_path = sys.argv[1:]
text = pathlib.Path(stdout_path).read_text(errors="replace").strip()
stderr = pathlib.Path(stderr_path).read_text(errors="replace")
try:
    value = json.loads(text)
except json.JSONDecodeError:
    value = None
pathlib.Path(meta).write_text(json.dumps({
    "name": name,
    "expectedExit": int(expected),
    "exit": int(code),
    "json": value,
    "jsonValue": value is not None,
    "stderr": stderr,
}, sort_keys=True) + "\n")
if int(code) != int(expected) or not isinstance(value, dict):
    raise SystemExit(1)
if int(expected) == 0 and value.get("success") is not True:
    raise SystemExit(1)
PY
  metadata_status=$?
  set -e
  if [[ "$metadata_status" -ne 0 ]]; then
    return 1
  fi
}

run_checked_step() {
  if run_step "$@"; then
    :
  else
    FAILED=1
  fi
}

expect_data_field() {
  local name="$1" field="$2" expected="$3"
  local assertion_status
  set +e
  python3 - "$LAST_STDOUT" "$name" "$field" "$expected" <<'PY'
import json
import pathlib
import sys

stdout_path, name, field, expected = sys.argv[1:]
value = json.loads(pathlib.Path(stdout_path).read_text(errors="replace"))
data = value.get("data")
observed = data.get(field) if isinstance(data, dict) else None
if field == "result" and isinstance(observed, str):
    try:
        observed = json.loads(observed)
    except json.JSONDecodeError:
        pass
if value.get("success") is not True or observed != expected:
    raise SystemExit(f"{name}: expected data.{field} to equal {expected!r}; observed={value!r}")
PY
  assertion_status=$?
  set -e
  if [[ "$assertion_status" -ne 0 ]]; then
    FAILED=1
  fi
}

expect_session_id() {
  local name="$1"
  local assertion_status
  set +e
  python3 - "$LAST_STDOUT" "$name" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(errors="replace"))
data = value.get("data")
session_id = data.get("sessionId") if isinstance(data, dict) else None
if value.get("success") is not True or not isinstance(session_id, str) or not session_id:
    raise SystemExit(f"{sys.argv[2]}: connect did not return a non-empty sessionId")
PY
  assertion_status=$?
  set -e
  if [[ "$assertion_status" -ne 0 ]]; then
    FAILED=1
  fi
}

expect_status_77() {
  local name="$1"
  local assertion_status
  set +e
  python3 - "$LAST_STDOUT" "$name" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(errors="replace"))
if value.get("success") is not False or value.get("errorType") != "no_session":
    raise SystemExit(f"{sys.argv[2]}: expected no_session failure; observed={value!r}")
PY
  assertion_status=$?
  set -e
  if [[ "$assertion_status" -ne 0 ]]; then
    FAILED=1
  fi
}

expect_tab_url() {
  local name="$1" expected_url="$2"
  local assertion_status
  set +e
  python3 - "$LAST_STDOUT" "$name" "$expected_url" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(errors="replace"))
data = value.get("data")
tabs = data.get("tabs") if isinstance(data, dict) else None
if value.get("success") is not True or not isinstance(tabs, list):
    raise SystemExit(f"{sys.argv[2]}: tab list is not a successful array")
if not any(isinstance(tab, dict) and tab.get("url") == sys.argv[3] for tab in tabs):
    raise SystemExit(f"{sys.argv[2]}: expected tab URL {sys.argv[3]!r}; observed={value!r}")
PY
  assertion_status=$?
  set -e
  if [[ "$assertion_status" -ne 0 ]]; then
    FAILED=1
  fi
}

expect_batch() {
  local name="$1" expected_url="$2" expected_title="$3"
  local assertion_status
  set +e
  python3 - "$LAST_STDOUT" "$name" "$expected_url" "$expected_title" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(errors="replace"))
data = value.get("data")
results = data.get("results") if isinstance(data, dict) else None
if value.get("success") is not True or not isinstance(results, list) or len(results) != 2:
    raise SystemExit(f"{sys.argv[2]}: expected two successful batch results; observed={value!r}")
expected_commands = [["get", "url"], ["get", "title"]]
for item, command in zip(results, expected_commands):
    if not isinstance(item, dict) or item.get("success") is not True or item.get("command") != command:
        raise SystemExit(f"{sys.argv[2]}: batch command/result mismatch; observed={value!r}")
first_result = results[0].get("result")
second_result = results[1].get("result")
if (
    not isinstance(first_result, dict)
    or first_result.get("url") != sys.argv[3]
    or not isinstance(second_result, dict)
    or second_result.get("title") != sys.argv[4]
):
    raise SystemExit(f"{sys.argv[2]}: batch values mismatch; observed={value!r}")
PY
  assertion_status=$?
  set -e
  if [[ "$assertion_status" -ne 0 ]]; then
    FAILED=1
  fi
}

cleanup() {
  if [[ -e "$HOME/.moat/session" ]]; then
    local cleanup_status
    set +e
    "$MOAT" --json disconnect >"$LOG_DIR/cleanup.stdout" 2>"$LOG_DIR/cleanup.stderr"
    cleanup_status=$?
    set -e
    if [[ "$cleanup_status" -ne 0 ]]; then
      echo "basic scenario cleanup failed with exit ${cleanup_status}" >&2
      FAILED=1
    fi
  fi
  if [[ -e "$HOME/.moat/session" ]]; then
    echo "basic scenario left an active session file" >&2
    FAILED=1
  fi
}

run_title_lifecycle() {
  local profile="$1" prefix="$2"
  local probe_url="${FIXTURE_ROOT}/probe"
  run_checked_step "${prefix}-connect" 0 connect --profile "$profile"
  expect_session_id "${prefix}-connect"
  run_checked_step "${prefix}-open" 0 open "$probe_url"
  run_checked_step "${prefix}-eval-title" 0 eval "document.title = 'Clean container build'"
  expect_data_field "${prefix}-eval-title" result "Clean container build"
  run_checked_step "${prefix}-get-title" 0 get title
  expect_data_field "${prefix}-get-title" title "Clean container build"
  run_checked_step "${prefix}-get-url" 0 get url
  expect_data_field "${prefix}-get-url" url "$probe_url"
  run_checked_step "${prefix}-disconnect" 0 disconnect
  run_checked_step "${prefix}-status-after-disconnect" 77 status
  expect_status_77 "${prefix}-status-after-disconnect"
}

if [[ "$MODE" == "second" ]]; then
  run_title_lifecycle "$EMPTY_PROFILE" second
  run_checked_step second-connect-empty 0 connect --profile "$EMPTY_PROFILE"
  expect_session_id second-connect-empty
  run_checked_step second-open-private 0 open "${FIXTURE_ROOT}/private"
  run_checked_step second-auth-state 0 get attr "#auth-state" "data-auth-state"
  expect_data_field second-auth-state value logged-out
  run_checked_step second-disconnect 0 disconnect
else
  run_title_lifecycle "$EMPTY_PROFILE" lifecycle

  run_checked_step bridge-connect-default 0 connect --profile "$TEST_PROFILE"
  expect_session_id bridge-connect-default
  run_checked_step bridge-open-authenticated 0 open "${FIXTURE_ROOT}/private"
  run_checked_step bridge-auth-state 0 get attr "#auth-state" "data-auth-state"
  expect_data_field bridge-auth-state value authenticated
  run_checked_step bridge-auth-identity 0 get attr "#auth-state" "data-authenticated-user"
  expect_data_field bridge-auth-identity value "$EXPECTED_IDENTITY"

  run_checked_step json-route 0 open "${FIXTURE_ROOT}/json"
  run_checked_step json-body 0 get text body
  expect_data_field json-body text '{"original":true}'

  run_checked_step binary-page 0 open "${FIXTURE_ROOT}/"
  run_checked_step binary-bytes 0 eval "fetch('${FIXTURE_ROOT}/binary').then(r => r.arrayBuffer()).then(b => Array.from(new Uint8Array(b)).join(','))"
  expect_data_field binary-bytes result "0,255,128,254"

  run_checked_step router-route 0 open "${FIXTURE_ROOT}/router"
  run_checked_step router-push 0 pushstate /routed
  run_checked_step router-dom 0 get text "#route"
  expect_data_field router-dom text router:/routed
  run_checked_step router-url 0 get url
  expect_data_field router-url url "${FIXTURE_ROOT}/routed"

  run_checked_step tab-new 0 tab new "${FIXTURE_ROOT}/json"
  run_checked_step tab-list 0 tab list
  expect_tab_url tab-list "${FIXTURE_ROOT}/json"
  run_checked_step tab-close 0 tab close

  run_checked_step batch-inline 0 batch <<'JSON'
[["get","url"],["get","title"]]
JSON
  expect_batch batch-inline "${FIXTURE_ROOT}/routed" "Clean Container Fixture Router"

  run_checked_step bridge-disconnect 0 disconnect
  run_checked_step bridge-connect-empty 0 connect --profile "$EMPTY_PROFILE"
  expect_session_id bridge-connect-empty
  run_checked_step empty-open-private 0 open "${FIXTURE_ROOT}/private"
  run_checked_step empty-auth-state 0 get attr "#auth-state" "data-auth-state"
  expect_data_field empty-auth-state value logged-out
  run_checked_step empty-disconnect 0 disconnect
fi

cleanup
python3 - "$LOG_DIR/summary.json" "$FAILED" "$STEP" "$MODE" <<'PY'
import json
import pathlib
import sys

summary, failed, steps, mode = sys.argv[1:]
pathlib.Path(summary).write_text(json.dumps({
    "scenario": "basic-cli-lifecycle" if mode == "second" else "basic-cli-and-profile-bridge",
    "mode": mode,
    "steps": int(steps),
    "failed": int(failed),
    "passed": int(failed) == 0,
}, sort_keys=True) + "\n")
PY

if [[ "$FAILED" -ne 0 ]]; then
  exit 1
fi
