# Spike #139: CLI → Controller WebSocket Round-Trip

**Date**: 2026-04-10
**Status**: Partial pass — wire protocol works, blocked by missing Docker image

## Checkpoint Results

| # | Dimension | Check | Result | Notes |
|---|-----------|-------|--------|-------|
| 1 | environment | Controller container running | **PASS** | HTTP 426 (Upgrade Required) on `http://192.168.1.211:3000/` confirms WebSocket server is up. SSH to VM failed (key auth), so `km ps` / `docker ps` could not be run directly. |
| 2 | environment | CLI binary exists and runs | **PASS** | `./cli/target/release/moat --help` exits 0, prints full help text. Binary name is `moat` (not `agent-browser`). |
| 3 | assumption | WebSocket reachable | **PASS** | `moat status` exits 77 with "No active session" — no connection errors. The `status` command checks local session file only (doesn't hit WebSocket), but checkpoint 4 confirms WebSocket connectivity. |
| 4 | integration | Session register round-trip | **FAIL** | WebSocket round-trip WORKS — Controller received the `register` command and responded with error code 80: `Container creation failed: Docker create failed (404): No such image: moat-agent-chrome:latest`. The wire protocol is functional; the failure is a deployment issue. |
| 5 | integration | Command round-trip | **SKIP** | Blocked by checkpoint 4 (no session). |
| 6 | integration | Session deregister round-trip | **SKIP** | Blocked by checkpoint 4 (no session). |

**Checkpoints: 3/6 passed (dimensions: environment 2/2, assumption 1/1, integration 0/3)**

## Key Findings

1. **Wire protocol round-trip is functional.** The CLI successfully connects to the Controller via WebSocket, sends a `register` command, and receives a structured error response. The entire SDK → WebSocket → Controller → Docker API path is exercised.

2. **Blocker: `moat-agent-chrome:latest` image not present on VM 104.** The Controller tries to `docker create` from this image and gets a 404. Fix: build and deploy the image via `km x run-build moat-agent-chrome` + `km x deploy-stack moat-browser`.

3. **SSH to Browser VM (192.168.1.211) is broken.** Both the ssh-manager MCP tool and direct SSH fail with "Permission denied (publickey)". The host key was regenerated at some point (stale ECDSA key in known_hosts was cleared, but key-based auth still fails). This blocks direct `docker ps` verification and any image build/deploy from this workstation.

4. **`moat status` is local-only.** It reads `~/.moat/session` — it does not contact the Controller. Checkpoint 3 confirms the CLI runs without errors, but does not prove WebSocket connectivity. Checkpoint 4 proves WebSocket connectivity.

## Unblocking Next Steps

1. Fix SSH key auth to Browser VM (192.168.1.211) — likely needs re-copying the public key
2. Build `moat-agent-chrome` image: `km x run-build moat-agent-chrome`
3. Deploy stack: `km x deploy-stack moat-browser`
4. Re-run checkpoints 4-6
