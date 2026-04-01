/**
 * shim.test.ts — Scenario group D: Shim SDK integration
 *
 * D1: shim SDK connect → navigate → snapshot → disconnect full flow
 * D2: shim daemon → Unix socket → command → result
 * D3: shim auto-reconnect (after controller restart)
 *
 * All tests require Docker Compose stack to be running.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import net from "net";
import {
  waitForPort,
  createTestClient,
  assertResult,
  assertNotCommandError,
  TEST_WEBAPP_URL,
  makeToken,
  TEST_GATEWAY,
} from "./helpers.js";
import { MoatBrowserClient, ShimDaemon } from "@moat-browser/shim";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";

const CONTROLLER_PORT = 9800;
const INFRASTRUCTURE_TIMEOUT = 60_000;

describe("Phase 9 - Scenario D: Shim Integration", () => {
  beforeAll(async () => {
    await waitForPort(CONTROLLER_PORT, { timeout: INFRASTRUCTURE_TIMEOUT });
  }, INFRASTRUCTURE_TIMEOUT);

  /**
   * D1: Full SDK flow — connect → navigate → snapshot → disconnect
   */
  test("D1: SDK connect → navigate → snapshot → disconnect", async () => {
    const client = await createTestClient();

    // Connect
    const reg = await client.connect();
    if ("_tag" in reg) {
      throw new Error(`D1: connect() failed: ${JSON.stringify(reg)}`);
    }

    expect(typeof reg.sessionId).toBe("string");

    // Navigate
    const nav = await client.navigate(`${TEST_WEBAPP_URL}/`);
    assertNotCommandError(nav, "D1 navigate");
    assertResult(nav, "NavigateResult");
    expect(nav.url).toContain("8888");

    // Snapshot
    const snap = await client.snapshot();
    assertNotCommandError(snap, "D1 snapshot");
    assertResult(snap, "SnapshotResult");
    expect(snap.snapshot.length).toBeGreaterThan(0);

    // Disconnect
    await client.disconnect();
  }, 120_000);

  /**
   * D2: Shim daemon — Unix socket → command → result
   * The daemon listens on a Unix socket and proxies JSON-line commands to the controller.
   */
  test("D2: shim daemon accepts commands via Unix socket", async () => {
    const socketPath = join(tmpdir(), `moat-test-${crypto.randomUUID()}.sock`);
    const token = await makeToken({ agentId: "daemon-test-agent" });

    const daemon = new ShimDaemon({
      gateway: TEST_GATEWAY,
      token,
      agentId: "daemon-test-agent",
      socketPath,
    });

    await daemon.start();

    try {
      // Wait for socket file to appear
      let socketExists = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (existsSync(socketPath)) {
          socketExists = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      expect(socketExists).toBe(true);

      // Send a Navigate command via Unix socket (JSON-line protocol)
      const response = await sendDaemonCommand(socketPath, {
        id: "test-1",
        command: "Navigate",
        url: `${TEST_WEBAPP_URL}/`,
      });

      expect(response.ok).toBe(true);

      if (response.ok) {
        const result = response.result;
        if (!result || typeof result !== "object" || !("_tag" in result)) {
          throw new Error(`D2: daemon response has no result._tag: ${JSON.stringify(response)}`);
        }
        expect(result._tag).toBe("NavigateResult");
      }

      // Send a Snapshot command
      const snapResp = await sendDaemonCommand(socketPath, {
        id: "test-2",
        command: "Snapshot",
      });

      expect(snapResp.ok).toBe(true);
      if (snapResp.ok) {
        expect(snapResp.result?._tag).toBe("SnapshotResult");
      }
    } finally {
      await daemon.stop();
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
    }
  }, 120_000);

  /**
   * D3: Auto-reconnect — shim re-establishes after transport-level drop
   * Socket.IO's built-in reconnection + session resume within the 5s window.
   */
  test("D3: SDK auto-reconnects after transient disconnect", async () => {
    const client = await createTestClient({ agentId: "reconnect-test" });

    // Connect
    const reg = await client.connect();
    if ("_tag" in reg) {
      throw new Error(`D3: connect() failed: ${JSON.stringify(reg)}`);
    }

    const sessionId = reg.sessionId;

    // Navigate to establish a session
    const nav1 = await client.navigate(`${TEST_WEBAPP_URL}/`);
    assertNotCommandError(nav1, "D3 initial navigate");
    assertResult(nav1, "NavigateResult");

    // Force a transport-level disconnect (socket drop without deregister)
    client.forceDisconnect();

    // Wait briefly — within the 5s reconnect window
    await new Promise((r) => setTimeout(r, 1_500));

    // Reconnect the socket and resume
    const reg2 = await client.connect();
    if ("_tag" in reg2) {
      // New session — try to resume the original
    }

    const resumed = await client.resume(sessionId);
    if ("_tag" in resumed) {
      throw new Error(
        `D3: resume() after reconnect failed: ${JSON.stringify(resumed)}\n` +
          `Expected session to still be alive within the reconnect window.`
      );
    }

    expect(resumed.sessionId).toBe(sessionId);

    // Browser state should be preserved — snapshot still works
    const snap = await client.snapshot();
    assertNotCommandError(snap, "D3 snapshot after reconnect");
    assertResult(snap, "SnapshotResult");

    await client.disconnect();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Unix socket protocol helper (used in D2)
// ---------------------------------------------------------------------------

interface DaemonRequest {
  id: string;
  command: string;
  [key: string]: unknown;
}

interface DaemonResponseOk {
  id: string;
  ok: true;
  result: { _tag: string; [key: string]: unknown } | null | undefined;
}

interface DaemonResponseErr {
  id: string;
  ok: false;
  error: { _tag: string; message: string };
}

type DaemonResponse = DaemonResponseOk | DaemonResponseErr;

/**
 * Send a single JSON-line command to the daemon's Unix socket and wait for the response.
 */
async function sendDaemonCommand(
  socketPath: string,
  req: DaemonRequest
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buffer = "";

    const timeout = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Daemon command timeout after 10s for request ${JSON.stringify(req)}`));
    }, 10_000);

    sock.once("connect", () => {
      sock.write(JSON.stringify(req) + "\n");
    });

    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        clearTimeout(timeout);
        sock.destroy();
        try {
          resolve(JSON.parse(trimmed) as DaemonResponse);
        } catch (e) {
          reject(new Error(`Invalid JSON from daemon: ${trimmed}`));
        }
      }
    });

    sock.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
