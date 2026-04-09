# CLI E2E Test Results

Run date: 2026-04-10
Stack: `moat-browser` on VM 104 (192.168.1.211)
Script: `packages/e2e/cli-e2e.sh`

## Summary

- **Total**: 78
- **Pass**: 12
- **Fail**: 66

### Failure breakdown

| Category | Count | Root cause |
|----------|-------|------------|
| Crash | 1 | L1 `find role link` crashes Controller (WebSocket reset) |
| Connection issue | 54 | Cascading — Controller down after L1 crash |
| Command format mismatch | 8 | CLI `get`/`is` expect `<subcommand> <selector>`, tests use `<selector> <subcommand>` |
| Not implemented | 1 | S6 `--profile default` — no default profile on server |
| Response format mismatch | 2 | N4 forward timeout (should error); EC3 wrong exit code |

## Results

| # | Test | Status | Issue Description | Category |
|---|------|--------|-------------------|----------|
| S1 | status (no session) | Pass | — | Pass |
| S2 | connect | Pass | — | Pass |
| S3 | status (with session) | Pass | — | Pass |
| S4 | disconnect | Pass | — | Pass |
| S5 | status after disconnect | Pass | — | Pass |
| S6 | connect --profile default | Fail | Profile copy failed: `cp -a default` — no default profile exists on server | Not implemented |
| N1 | open URL with scheme | Pass | — | Pass |
| N2 | open URL without scheme | Pass | — | Pass |
| N3 | back | Pass | — | Pass |
| N4 | forward | Fail | Timeout 30s — no forward history, should return error not hang | Response format mismatch |
| N5 | reload | Pass | — | Pass |
| L1 | find role link --name | Fail | WebSocket protocol error: Connection reset without closing handshake | Crash |
| L2 | find role heading --name | Fail | Connection refused (controller down from L1 crash) | Connection issue |
| L3 | find text | Fail | Connection refused (controller down from L1 crash) | Connection issue |
| L4 | find role link click | Fail | Connection refused (controller down from L1 crash) | Connection issue |
| L5 | find label fill (username) | Fail | Connection refused (controller down from L1 crash) | Connection issue |
| L6 | find label fill (password) | Fail | Connection refused (controller down from L1 crash) | Connection issue |
| L7 | find role button click | Fail | Connection refused (controller down from L1 crash) | Connection issue |
| L8 | find text (verify login) | Fail | Connection refused (controller down from L1 crash) | Connection issue |
| R1 | snapshot | Fail | No active session (connect failed — controller down) | Connection issue |
| R2 | click @e1 | Fail | No active session (connect failed — controller down) | Connection issue |
| R3 | hover @e1 | Fail | No active session (connect failed — controller down) | Connection issue |
| C1 | click CSS selector | Fail | No active session (connect failed — controller down) | Connection issue |
| C2 | fill CSS selector | Fail | No active session (connect failed — controller down) | Connection issue |
| C3 | type CSS selector | Fail | No active session (connect failed — controller down) | Connection issue |
| C4 | hover CSS selector | Fail | No active session (connect failed — controller down) | Connection issue |
| P1 | snapshot | Fail | No active session (connect failed — controller down) | Connection issue |
| P2 | snapshot --json | Fail | No active session (connect failed — controller down) | Connection issue |
| P3 | screenshot | Fail | No active session (connect failed — controller down) | Connection issue |
| P4 | screenshot --json | Fail | No active session (connect failed — controller down) | Connection issue |
| P5 | eval document.title | Fail | No active session (connect failed — controller down) | Connection issue |
| P6 | eval arithmetic | Fail | No active session (connect failed — controller down) | Connection issue |
| P7 | eval --json | Fail | No active session (connect failed — controller down) | Connection issue |
| K1 | press Enter | Fail | No active session (connect failed — controller down) | Connection issue |
| K2 | press Tab | Fail | No active session (connect failed — controller down) | Connection issue |
| K3 | press combo key | Fail | No active session (connect failed — controller down) | Connection issue |
| K4 | scroll down | Fail | No active session (connect failed — controller down) | Connection issue |
| K5 | scroll up 500 | Fail | No active session (connect failed — controller down) | Connection issue |
| T1 | tab list | Fail | No active session (connect failed — controller down) | Connection issue |
| T2 | tab new | Fail | No active session (connect failed — controller down) | Connection issue |
| T3 | tab list (2 tabs) | Fail | No active session (connect failed — controller down) | Connection issue |
| T4 | tab switch | Fail | No active session (connect failed — controller down) | Connection issue |
| T5 | tab close | Fail | No active session (connect failed — controller down) | Connection issue |
| CK1 | cookies list | Fail | No active session (connect failed — controller down) | Connection issue |
| CK2 | cookies --json | Fail | No active session (connect failed — controller down) | Connection issue |
| CK3 | cookies clear | Fail | No active session (connect failed — controller down) | Connection issue |
| W1 | wait fixed time | Fail | No active session (connect failed — controller down) | Connection issue |
| W2 | wait text | Fail | No active session (connect failed — controller down) | Connection issue |
| W3 | wait url pattern | Fail | No active session (connect failed — controller down) | Connection issue |
| W4 | wait load | Fail | No active session (connect failed — controller down) | Connection issue |
| G1 | get text (selector) | Fail | Unknown subcommand: #username — CLI expects `get text <selector>` not `get <selector> text` | Command format mismatch |
| G2 | get value (selector) | Fail | Unknown subcommand: #username — CLI expects `get value <selector>` not `get <selector> value` | Command format mismatch |
| G3 | is visible (selector) | Fail | Unknown subcommand: #username — CLI expects `is visible <selector>` not `is <selector> visible` | Command format mismatch |
| G4 | is enabled (selector) | Fail | Unknown subcommand: #username — CLI expects `is enabled <selector>` not `is <selector> enabled` | Command format mismatch |
| E1 | eval document.title | Fail | No active session (connect failed — controller down) | Connection issue |
| E2 | eval JSON.stringify | Fail | No active session (connect failed — controller down) | Connection issue |
| E3 | eval window.location.href | Fail | No active session (connect failed — controller down) | Connection issue |
| B1 | batch via stdin | Fail | No active session (connect failed — controller down) | Connection issue |
| X1 | close session | Fail | No active session (connect failed — controller down) | Connection issue |
| X2 | status after close | Pass | — | Pass |
| P1a | check checkbox | Fail | No active session (connect failed — controller down) | Connection issue |
| P1b | uncheck checkbox | Fail | No active session (connect failed — controller down) | Connection issue |
| P1c | is checked (selector) | Fail | Unknown subcommand: input[...] — CLI expects `is checked <selector>` not `is <selector> checked` | Command format mismatch |
| P1d | select dropdown | Fail | No active session (connect failed — controller down) | Connection issue |
| P1e | focus element | Fail | No active session (connect failed — controller down) | Connection issue |
| P1f | keyboard type | Fail | No active session (connect failed — controller down) | Connection issue |
| P1g | get text (result) | Fail | Unknown subcommand: #result — CLI expects `get text <selector>` not `get <selector> text` | Command format mismatch |
| J1 | snapshot --json | Fail | No active session (connect failed — controller down) | Connection issue |
| J2 | screenshot --json | Fail | No active session (connect failed — controller down) | Connection issue |
| J3 | eval --json | Fail | No active session (connect failed — controller down) | Connection issue |
| J4 | cookies --json | Fail | No active session (connect failed — controller down) | Connection issue |
| J5 | get text --json | Fail | Unknown subcommand: h1 — CLI expects `get --json text <selector>` not `get --json <selector> text` | Command format mismatch |
| J6 | is visible --json | Fail | Unknown subcommand: h1 — CLI expects `is --json visible <selector>` not `is --json <selector> visible` | Command format mismatch |
| J7 | tab list --json | Fail | No active session (connect failed — controller down) | Connection issue |
| EC1 | successful command → exit 0 | Fail | No active session (connect failed — controller down) | Connection issue |
| EC2 | no session → exit 77 | Pass | — | Pass |
| EC3 | no MOAT_CONTROLLER → exit 78 | Fail | Exit 69 instead of 78 — wrong exit code for missing controller URL | Response format mismatch |
| EC4 | unknown command → exit 1 | Pass | — | Pass |
