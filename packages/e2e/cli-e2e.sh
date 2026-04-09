#!/bin/bash
set -uo pipefail

# ─── CLI E2E Test Harness ───
# Phase 1: Session lifecycle tests (S1-S6)
# Phase 2: Navigation (N1-N5), Semantic locators (L1-L8), Snapshot + @ref (R1-R3)
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

# ─── Phase 2: Navigation (N1-N5) ───
"$MOAT" connect >/dev/null 2>&1

# TEST: N1 — open URL with scheme
run_test "N1" 0 open "https://example.com"

# TEST: N2 — open URL without scheme (auto https://)
run_test "N2" 0 open "example.com"

# TEST: N3 — back
run_test "N3" 0 back

# TEST: N4 — forward
run_test "N4" 0 forward

# TEST: N5 — reload
run_test "N5" 0 reload

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 2: Semantic Locators (L1-L8) ───
"$MOAT" connect >/dev/null 2>&1
"$MOAT" open "https://example.com" >/dev/null 2>&1

# TEST: L1 — find role link with name
run_test "L1" 0 find role link --name "More information..."

# TEST: L2 — find role heading with name
run_test "L2" 0 find role heading --name "Example Domain"

# TEST: L3 — find text
run_test "L3" 0 find text "Example Domain"

# TEST: L4 — find role link + click subaction
run_test "L4" 0 find role link click

"$MOAT" open "https://the-internet.herokuapp.com/login" >/dev/null 2>&1

# TEST: L5 — find label + fill (username)
run_test "L5" 0 find label "Username" fill "tomsmith"

# TEST: L6 — find label + fill (password)
run_test "L6" 0 find label "Password" fill "SuperSecretPassword!"

# TEST: L7 — find role button + click (login)
run_test "L7" 0 find role button --name "Login" click

# TEST: L8 — find text (verify login success)
run_test "L8" 0 find text "You logged into a secure area!"

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 2: Snapshot + @ref (R1-R3) ───
"$MOAT" connect >/dev/null 2>&1
"$MOAT" open "https://example.com" >/dev/null 2>&1

# TEST: R1 — snapshot (ARIA tree with @ref)
run_test "R1" 0 snapshot

# TEST: R2 — click @e1 (ref-based click)
run_test "R2" 0 click "@e1"

# TEST: R3 — hover @e1 (ref-based hover)
run_test "R3" 0 hover "@e1"

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── RESULTS ───
echo "=== RESULTS ==="
echo "Total: $TOTAL"
echo "Pass:  $PASS"
echo "Fail:  $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
