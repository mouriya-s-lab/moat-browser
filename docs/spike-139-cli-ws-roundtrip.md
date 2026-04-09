# Spike #139: CLI → Controller WebSocket Round-Trip

**Date**: 2026-04-10
**Status**: Partial pass — transport verified, agent-chrome image missing

## Summary

The moat CLI binary can establish a WebSocket connection to the deployed
Controller on Browser VM (192.168.1.211:3000) and exchange structured wire
protocol messages. The full session lifecycle (connect → command → disconnect)
is blocked by a missing `moat-agent-chrome` Docker image on the VM.

## Checkpoint Results

| # | Dimension | Result | Notes |
|---|-----------|--------|-------|
| 1 | environment | PASS | Controller + user-chrome running (up 24h) |
| 2 | environment | PASS | `moat --help` exits 0, prints help |
| 3 | assumption | PASS | `moat status` exits 77, "No active session" (not connection refused) |
| 4 | integration | PARTIAL | WebSocket + wire protocol works; Register fails: `moat-agent-chrome:latest` image not found (Docker 404) |
| 5 | integration | BLOCKED | Requires session from AC-4 |
| 6 | integration | BLOCKED | Requires session from AC-4 |

**Checkpoints: 3/6 passed, 1 partial, 2 blocked (environment 2/2, assumption 1/1, integration 0/3)**

## Key Findings

### Transport Layer: VERIFIED

The Rust SDK WebSocket transport works end-to-end:
1. `tokio-tungstenite` connects to `ws://192.168.1.211:3000`
2. `WireRequest::Register` serializes and sends correctly
3. Controller responds with `WireResponse::RegisterResult` (structured JSON)
4. Error contains actionable detail: Docker image name + HTTP 404

### Blocker: Missing agent-chrome Image

The Controller's register flow creates a Docker container per session.
The `moat-agent-chrome:latest` image has never been built on VM 104.

**Available images**: `moat-controller:latest`, `moat-user-chrome:latest`
**Missing**: `moat-agent-chrome:latest`

**Fix**: Build the agent-chrome image via `km x run-build moat-agent-chrome`
(requires km CLI access or Komodo dashboard).

## Conclusion

The spike's core question — *does the CLI→Controller WebSocket round-trip
work?* — is answered **YES**. The transport, serialization, and wire protocol
are all functional. AC-4/5/6 require the agent-chrome image to be built,
which is an infrastructure task, not an SDK/transport issue.

E2E test phases can proceed with confidence that the CLI→Controller pipeline
is sound, once the agent-chrome image is deployed.
