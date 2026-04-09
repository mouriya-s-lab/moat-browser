# Spike #139: CLI → Controller WebSocket Round-Trip

**Date**: 2026-04-10
**Status**: PASS — all 6 checkpoints pass

## Checkpoint Results

| # | Dimension | Check | Result | Notes |
|---|-----------|-------|--------|-------|
| 1 | environment | Controller container running | **PASS** | `moat-browser-controller-1` and `moat-browser-user-chrome-1` both running (verified via Komodo API ListDockerContainers). |
| 2 | environment | CLI binary exists and runs | **PASS** | `./cli/target/release/moat --help` exits 0, prints full help text. |
| 3 | assumption | WebSocket reachable | **PASS** | `moat status` exits 77 with "No active session" — no connection errors. |
| 4 | integration | Session register round-trip | **PASS** | `moat connect` exits 0, prints session ID (e.g. `56cebaec-b07f-4d05-8375-c4fdb2ef1bee`). Controller creates agent-chrome container, connects CDP, returns success. |
| 5 | integration | Command round-trip | **PASS** | `moat open https://example.com` exits 0, prints "Example Domain" + URL. Full pipeline: CLI → WebSocket → Controller → CDP → agent-chrome → Chromium. |
| 6 | integration | Session deregister round-trip | **PASS** | `moat disconnect` exits 0, prints "Disconnected." |

**Checkpoints: 6/6 passed (dimensions: environment 2/2, assumption 1/1, integration 3/3)**

## Bugs Found & Fixed

### 1. Tokio nested runtime panic in CLI `send_command`

`connection.rs:send_command()` called `tokio::runtime::Handle::current().block_on()` inside `#[tokio::main]` async context, causing panic: "Cannot start a runtime from within a runtime."

**Fix**: Made `send_command` async, added `.await` at call sites in `main.rs`.

### 2. CDP URL lost during session resume

When the CLI's WebSocket disconnects (process exits after `moat connect`), the Controller transitions the session Active → Reconnecting. The `Reconnecting` state only preserved `containerId`, dropping `containerIp` and `cdpUrl`. On resume, the Controller tried `connectCDP("")` → "Invalid URL".

**Fix**: Added `containerIp` and `cdpUrl` to the `Reconnecting` state type (`packages/types`) and preserved them through `markDisconnected` → `resume` in `session-registry.ts`.

### 3. Missing `moat-agent-chrome` Docker image (iteration 1)

The agent-chrome image had never been built on VM 104. Built via Komodo API `RunBuild`.

## Key Findings

1. **Full CLI↔Controller pipeline works.** The entire path — CLI (Rust) → WebSocket → Controller (Node.js) → Docker API → agent-chrome container → CDP → Chromium → page content → back to CLI — is functional.

2. **Session lifecycle works.** connect → command → disconnect all succeed. The stateless command model (new WebSocket per CLI invocation, resume session) works correctly after the CDP URL fix.

3. **281 Rust tests pass.** No regressions from the CLI changes.

4. **3 pre-existing TS test failures** in `cdp-bridge.test.ts` (snapshot, eval, wait) — unrelated to this spike, present on main.

## Conclusion

The CLI↔Controller WebSocket round-trip assumption is **verified**. Proceed to Phase 1 (E2E test harness).
