#!/usr/bin/env bash
set -Eeuo pipefail

: "${MOAT:?MOAT must name the installed candidate binary}"
: "${MOAT_CONTROLLER:?MOAT_CONTROLLER must target this run's Controller}"
: "${FIXTURE_URL:?FIXTURE_URL must target this run's fixture}"
: "${RESULT_DIR:?RESULT_DIR must be writable evidence output}"

readonly MATRIX_RESULT=/opt/moat-source/packages/e2e/cli-all-commands-results.json
readonly MATRIX_LOG="$RESULT_DIR/matrix/cli-all-commands.log"
matrix_fixture="${MATRIX_FIXTURE_URL:-${MOAT_FIXTURE_URL:-}}"
[[ -n "$matrix_fixture" ]] || {
  echo "matrix requires an explicit MATRIX_FIXTURE_URL secure origin" >&2
  exit 1
}

python3 - "$matrix_fixture" <<'PY'
from urllib.parse import urlparse
import sys

parsed = urlparse(sys.argv[1])
if parsed.scheme != "https" or not parsed.netloc:
    raise SystemExit("matrix fixture must be an explicit https URL with a host")
PY

mkdir -p "$RESULT_DIR/matrix"
rm -f "$MATRIX_RESULT"

set +e
env \
  MOAT="$MOAT" \
  MOAT_CONTROLLER="$MOAT_CONTROLLER" \
  MOAT_FIXTURE_URL="$matrix_fixture" \
  HOME="${HOME:?HOME must be isolated}" \
  bash /opt/moat-source/packages/e2e/cli-all-commands.sh --verify-isolation \
  >"$MATRIX_LOG" 2>&1
matrix_status=$?
set -e

report_path="$RESULT_DIR/matrix/cli-all-commands-results.json"
copy_status=0
if [[ -f "$MATRIX_RESULT" ]]; then
  set +e
  cp "$MATRIX_RESULT" "$report_path"
  copy_status=$?
  set -e
else
  printf '%s\n' '{"error":"matrix did not emit cli-all-commands-results.json"}' >"$report_path"
  copy_status=1
fi

validate_status=1
if [[ "$copy_status" -eq 0 ]]; then
  set +e
  python3 - "$report_path" "$MOAT" "$MOAT_CONTROLLER" "$matrix_status" <<'PY'
import json
import pathlib
import sys

report_path, moat, controller, matrix_status = sys.argv[1:]
report = json.loads(pathlib.Path(report_path).read_text())
if not isinstance(report, dict):
    raise SystemExit("matrix report is not a JSON object")
if int(matrix_status) != 0:
    raise SystemExit("matrix process returned a nonzero exit")
if report.get("moat") != str(pathlib.Path(moat).resolve()):
    raise SystemExit("matrix report moat path is not the explicit installed binary")
if report.get("controller") != controller:
    raise SystemExit("matrix report controller is not the explicit Controller endpoint")
if report.get("isolationPassed") is not True:
    raise SystemExit("matrix isolationPassed is not true")

empty_arrays = (
    "missing",
    "unknownCases",
    "duplicateCases",
    "caseAvailabilityMismatches",
    "failed",
    "noOp",
    "internalDiagnostics",
    "inventoryGaps",
    "topLevelMissing",
    "topLevelFailed",
)
for key in empty_arrays:
    value = report.get(key)
    if not isinstance(value, list) or value:
        raise SystemExit(f"matrix report {key} is not an empty array")

def positive_int(name):
    value = report.get(name)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise SystemExit(f"matrix report {name} is not a positive integer")
    return value

expected_actions = positive_int("expectedActions")
covered_actions = positive_int("coveredActions")
case_count = positive_int("cases")
expected_top_level = positive_int("expectedTopLevel")
covered_top_level = positive_int("coveredTopLevel")
if expected_actions != covered_actions:
    raise SystemExit("matrix action coverage counts differ")
if expected_top_level != covered_top_level:
    raise SystemExit("matrix top-level coverage counts differ")

action_inventory = report.get("actionInventory")
if not isinstance(action_inventory, list):
    raise SystemExit("matrix actionInventory is not an array")
inventory_actions = {
    entry.get("action")
    for entry in action_inventory
    if isinstance(entry, dict) and isinstance(entry.get("action"), str)
}
if len(inventory_actions) != expected_actions:
    raise SystemExit("matrix expectedActions disagrees with actionInventory")

results = report.get("results")
if not isinstance(results, list) or len(results) != case_count:
    raise SystemExit("matrix cases count disagrees with results")
covered_result_actions = {
    result.get("parserAction")
    for result in results
    if isinstance(result, dict) and isinstance(result.get("parserAction"), str)
}
if len(covered_result_actions) != covered_actions:
    raise SystemExit("matrix coveredActions disagrees with result parserAction coverage")
for result in results:
    if not isinstance(result, dict) or result.get("jsonValues") != 1 or result.get("effectPassed") is not True:
        raise SystemExit("matrix result lacks one JSON value or an observable effect assertion")

top_level_results = report.get("topLevelResults")
if not isinstance(top_level_results, list) or not top_level_results:
    raise SystemExit("matrix topLevelResults is empty")
top_level_names = {
    result.get("name")
    for result in top_level_results
    if isinstance(result, dict) and isinstance(result.get("name"), str)
}
if len(top_level_names) != covered_top_level:
    raise SystemExit("matrix coveredTopLevel disagrees with topLevelResults")
if any(not isinstance(result, dict) or result.get("passed") is not True for result in top_level_results):
    raise SystemExit("matrix top-level result failed")

contract_counts = report.get("contractCounts")
if not isinstance(contract_counts, dict) or any(
    isinstance(value, bool) or not isinstance(value, int) or value < 0
    for value in contract_counts.values()
):
    raise SystemExit("matrix contractCounts is not a nonnegative integer map")
PY
  validate_status=$?
  set -e
fi

overall_status=0
if [[ "$matrix_status" -ne 0 || "$copy_status" -ne 0 || "$validate_status" -ne 0 ]]; then
  overall_status=1
fi

python3 - "$RESULT_DIR/matrix/summary.json" "$overall_status" "$matrix_status" "$validate_status" "$MATRIX_LOG" "$matrix_fixture" <<'PY'
import json
import pathlib
import sys

summary, overall, matrix, validated, log, fixture = sys.argv[1:]
pathlib.Path(summary).write_text(json.dumps({
    "scenario": "exhaustive-cli-contract-matrix",
    "exit": int(overall),
    "matrixExit": int(matrix),
    "reportValidated": int(validated) == 0,
    "passed": int(overall) == 0,
    "fixture": fixture,
    "log": pathlib.Path(log).name,
    "report": "cli-all-commands-results.json",
}, sort_keys=True) + "\n")
PY

exit "$overall_status"
