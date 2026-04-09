#!/bin/bash
set -uo pipefail

# ─── CLI E2E Test Harness ───
# Phase 1: Session lifecycle tests (S1-S6)
# No assertions — human reviews log output.

MOAT="${MOAT:-./cli/target/release/moat}"
export MOAT_CONTROLLER="${MOAT_CONTROLLER:-ws://192.168.1.211:3000}"

TOTAL=0
PASS=0
FAIL=0

run_test() {
  local name="$1"
  local expect_exit="${2:-0}"
  shift 2
  TOTAL=$((TOTAL + 1))
  echo "=== TEST: $name ==="
  set +e
  output=$("$MOAT" "$@" 2>&1)
  code=$?
  set -e
  echo "$output"
  echo "exit: $code"
  if [ "$code" -eq "$expect_exit" ]; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL (expected exit $expect_exit, got $code)"
    FAIL=$((FAIL + 1))
  fi
  echo ""
}

# ─── Ensure clean state ───
"$MOAT" disconnect >/dev/null 2>&1 || true
rm -f ~/.moat/session 2>/dev/null || true

# TEST: S1 — status with no session → exit 77
run_test "S1" 77 status

# TEST: S2 — connect → exit 0, prints session ID
run_test "S2" 0 connect

# TEST: S3 — status (with session) → exit 0, shows session ID + controller URL
run_test "S3" 0 status

# TEST: S4 — disconnect → exit 0
run_test "S4" 0 disconnect

# TEST: S5 — status after disconnect → exit 77
run_test "S5" 77 status

# TEST: S6 — connect with --profile default → exit 0
run_test "S6" 0 connect --profile default

# Clean up session from S6
"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── RESULTS ───
echo "=== RESULTS ==="
echo "Total: $TOTAL"
echo "Pass:  $PASS"
echo "Fail:  $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
