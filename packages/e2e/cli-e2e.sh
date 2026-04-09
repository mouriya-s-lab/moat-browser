#!/bin/bash
set -uo pipefail

# ─── CLI E2E Test Harness ───
# Phase 1: Session lifecycle tests (S1-S6)
# Phase 2: Navigation (N1-N5), Semantic locators (L1-L8), Snapshot + @ref (R1-R3)
# Phase 3: CSS selector (C1-C4), Page info (P1-P7), Keyboard (K1-K5), Tab (T1-T5), Cookie (CK1-CK3)
# Phase 4: Wait (W1-W4), Get/Is (G1-G4), Evaluate (E1-E3), Batch (B1), Close (X1-X2),
#           P1 ops (P1a-P1g), JSON (J1-J7), Exit codes (EC1-EC4)
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
  set +e
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
run_test "L1" 0 find role link --name "Learn more"

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

# TEST: R3 — hover @e1 (ref-based hover, re-navigate after R2 click)
"$MOAT" open "https://example.com" >/dev/null 2>&1
"$MOAT" snapshot >/dev/null 2>&1
run_test "R3" 0 hover "@e1"

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 3: CSS Selector (C1-C4) ───
"$MOAT" connect >/dev/null 2>&1
"$MOAT" open "https://the-internet.herokuapp.com/login" >/dev/null 2>&1

# TEST: C1 — click CSS selector
run_test "C1" 0 click "#login button"

# TEST: C2 — fill CSS selector
run_test "C2" 0 fill "#username" "test"

# TEST: C3 — type CSS selector
run_test "C3" 0 type "#username" "test"

# TEST: C4 — hover CSS selector
run_test "C4" 0 hover "#login button"

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 3: Page Info (P1-P7) ───
"$MOAT" connect >/dev/null 2>&1
"$MOAT" open "https://example.com" >/dev/null 2>&1

# TEST: P1 — snapshot (ARIA tree text)
run_test "P1" 0 snapshot

# TEST: P2 — snapshot --json
run_test "P2" 0 snapshot --json

# TEST: P3 — screenshot (known gap: CLI expects data.path, Controller returns base64)
run_test "P3" 0 screenshot

# TEST: P4 — screenshot --json
run_test "P4" 0 screenshot --json

# TEST: P5 — eval document.title
run_test "P5" 0 eval "document.title"

# TEST: P6 — eval arithmetic
run_test "P6" 0 eval "1 + 1"

# TEST: P7 — eval --json
run_test "P7" 0 eval --json "document.title"

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 3: Keyboard/Scroll (K1-K5) ───
"$MOAT" connect >/dev/null 2>&1
"$MOAT" open "https://example.com" >/dev/null 2>&1

# TEST: K1 — press Enter
run_test "K1" 0 press Enter

# TEST: K2 — press Tab
run_test "K2" 0 press Tab

# TEST: K3 — press combo key
run_test "K3" 0 press "Control+a"

# TEST: K4 — scroll down
run_test "K4" 0 scroll down

# TEST: K5 — scroll up with amount
run_test "K5" 0 scroll up 500

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 3: Tab Management (T1-T5) ───
"$MOAT" connect >/dev/null 2>&1
"$MOAT" open "https://example.com" >/dev/null 2>&1

# TEST: T1 — tab list
run_test "T1" 0 tab list

# TEST: T2 — tab new
run_test "T2" 0 tab new "https://example.org"

# TEST: T3 — tab list (expect 2 tabs)
run_test "T3" 0 tab list

# TEST: T4 — tab switch back to first
run_test "T4" 0 tab switch 0

# TEST: T5 — tab close second
run_test "T5" 0 tab close 1

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 3: Cookie (CK1-CK3) ───
"$MOAT" connect >/dev/null 2>&1
"$MOAT" open "https://example.com" >/dev/null 2>&1

# TEST: CK1 — cookies list
run_test "CK1" 0 cookies

# TEST: CK2 — cookies --json
run_test "CK2" 0 cookies --json

# TEST: CK3 — cookies clear
run_test "CK3" 0 cookies clear

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 4: Wait (W1-W4) ───
"$MOAT" connect >/dev/null 2>&1
"$MOAT" open "https://the-internet.herokuapp.com/dynamic_loading/1" >/dev/null 2>&1

# TEST: W1 — wait fixed time
run_test "W1" 0 wait 2000

# TEST: W2 — click Start then wait for text
"$MOAT" find role button --name "Start" click >/dev/null 2>&1
run_test "W2" 0 wait --text "Hello World!"

# TEST: W3 — wait for JS function to return true
run_test "W3" 0 wait --fn "() => document.readyState === 'complete'"

# TEST: W4 — wait for load state
run_test "W4" 0 wait --load load

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 4: Get/Is (G1-G4) ───
"$MOAT" connect >/dev/null 2>&1
"$MOAT" open "https://the-internet.herokuapp.com/login" >/dev/null 2>&1

# TEST: G1 — get text
run_test "G1" 0 get text "#username"

# TEST: G2 — get value
run_test "G2" 0 get value "#username"

# TEST: G3 — is visible
run_test "G3" 0 is visible "#username"

# TEST: G4 — is enabled
run_test "G4" 0 is enabled "#username"

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 4: Evaluate (E1-E3) ───
"$MOAT" connect >/dev/null 2>&1
"$MOAT" open "https://the-internet.herokuapp.com/login" >/dev/null 2>&1

# TEST: E1 — eval document.title
run_test "E1" 0 eval "document.title"

# TEST: E2 — eval JSON.stringify
run_test "E2" 0 eval "JSON.stringify({a:1})"

# TEST: E3 — eval window.location.href
run_test "E3" 0 eval "window.location.href"

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 4: Batch (B1) ───
"$MOAT" connect >/dev/null 2>&1

# TEST: B1 — batch via stdin
b1_name="B1"
TOTAL=$((TOTAL + 1))
echo "=== TEST: $b1_name ==="
set +e
b1_output=$(echo '[["open","https://example.com"],["eval","document.title"]]' | "$MOAT" batch 2>&1)
b1_code=$?
set +e
echo "$b1_output"
echo "exit: $b1_code"
if [ "$b1_code" -eq 0 ]; then
  echo "PASS"
  PASS=$((PASS + 1))
else
  echo "FAIL (expected exit 0, got $b1_code)"
  FAIL=$((FAIL + 1))
fi
echo ""

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 4: Close (X1-X2) ───
"$MOAT" connect >/dev/null 2>&1

# TEST: X1 — close session
run_test "X1" 0 close

# TEST: X2 — status after close → exit 77
run_test "X2" 77 status

# ─── Phase 4: P1 Element Operations (P1a-P1g) ───
"$MOAT" connect >/dev/null 2>&1
"$MOAT" open "https://the-internet.herokuapp.com/checkboxes" >/dev/null 2>&1

# TEST: P1a — check checkbox
run_test "P1a" 0 check "input[type=checkbox]:first-child"

# TEST: P1b — uncheck checkbox
run_test "P1b" 0 uncheck "input[type=checkbox]:first-child"

# TEST: P1c — is checked
run_test "P1c" 0 is checked "input[type=checkbox]:first-child"

"$MOAT" open "https://the-internet.herokuapp.com/dropdown" >/dev/null 2>&1

# TEST: P1d — select dropdown
run_test "P1d" 0 select "#dropdown" "Option 1"

"$MOAT" open "https://the-internet.herokuapp.com/key_presses" >/dev/null 2>&1

# TEST: P1e — focus element
run_test "P1e" 0 focus "#target"

# TEST: P1f — keyboard type
run_test "P1f" 0 keyboard type "hello"

# TEST: P1g — press key then get result
"$MOAT" press "a" >/dev/null 2>&1
run_test "P1g" 0 get text "#result"

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 4: JSON Mode Spot-Checks (J1-J7) ───
"$MOAT" connect >/dev/null 2>&1
"$MOAT" open "https://example.com" >/dev/null 2>&1

# TEST: J1 — snapshot --json
run_test "J1" 0 snapshot --json

# TEST: J2 — screenshot --json
run_test "J2" 0 screenshot --json

# TEST: J3 — eval --json
run_test "J3" 0 eval --json "document.title"

# TEST: J4 — cookies --json
run_test "J4" 0 cookies --json

# TEST: J5 — get text --json
run_test "J5" 0 get --json text "h1"

# TEST: J6 — is visible --json
run_test "J6" 0 is --json visible "h1"

# TEST: J7 — tab list --json
run_test "J7" 0 tab list --json

"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── Phase 4: Exit Code Verification (EC1-EC4) ───

# TEST: EC1 — successful command → exit 0
"$MOAT" connect >/dev/null 2>&1
run_test "EC1" 0 open "https://example.com"
"$MOAT" disconnect >/dev/null 2>&1 || true

# TEST: EC2 — no session → exit 77
rm -f ~/.moat/session 2>/dev/null || true
run_test "EC2" 77 status

# TEST: EC3 — no MOAT_CONTROLLER → exit 78
ec3_name="EC3"
TOTAL=$((TOTAL + 1))
echo "=== TEST: $ec3_name ==="
set +e
ec3_output=$(MOAT_CONTROLLER="" "$MOAT" connect 2>&1)
ec3_code=$?
set +e
echo "$ec3_output"
echo "exit: $ec3_code"
if [ "$ec3_code" -eq 78 ]; then
  echo "PASS"
  PASS=$((PASS + 1))
else
  echo "FAIL (expected exit 78, got $ec3_code)"
  FAIL=$((FAIL + 1))
fi
echo ""

# TEST: EC4 — unknown command → exit 1
"$MOAT" connect >/dev/null 2>&1
run_test "EC4" 1 nonexistent-command
"$MOAT" disconnect >/dev/null 2>&1 || true

# ─── RESULTS ───
echo "=== RESULTS ==="
echo "Total: $TOTAL"
echo "Pass:  $PASS"
echo "Fail:  $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
