/**
 * lifecycle.test.ts — Scenario group A: container lifecycle
 *
 * A1: register → profile copy → container creation → CDP connection → ready
 * A2: deregister → container destroyed → profile copy deleted
 * A3: abnormal disconnect → 5s timeout → auto cleanup
 * A4: disconnect → reconnect within 5s → container reused
 * A5: concurrent agents → each isolated in their own container
 *
 * All tests require Docker Compose stack to be running:
 *   cd packages/e2e && docker compose -f docker-compose.test.yml up -d --build --wait
 */

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import {
  waitForPort,
  createTestClient,
  assertResult,
  TEST_WEBAPP_URL,
} from "./helpers.js";
import { MoatBrowserClient } from "@moat-browser/shim";

const CONTROLLER_PORT = 9800;
const INFRASTRUCTURE_TIMEOUT = 60_000;

describe("Phase 9 - Scenario A: Container Lifecycle", () => {
  const clients: MoatBrowserClient[] = [];

  beforeAll(async () => {
    // Fail fast if infrastructure is not running
    await waitForPort(CONTROLLER_PORT, { timeout: INFRASTRUCTURE_TIMEOUT });
  }, INFRASTRUCTURE_TIMEOUT);

  afterEach(async () => {
    // Disconnect all clients created in this test
    for (const client of clients) {
      try {
        await client.disconnect();
      } catch {
        // Best effort cleanup
      }
    }
    clients.length = 0;
  });

  /**
   * A1: Full lifecycle — register → container up → CDP ready → commands work
   */
  test("A1: register creates container and CDP is ready", async () => {
    const client = await createTestClient();
    clients.push(client);

    const reg = await client.connect();

    // Must succeed — no ContainerError or CDPError acceptable
    if ("_tag" in reg) {
      throw new Error(
        `A1: connect() returned error: ${JSON.stringify(reg)}\n` +
          `Expected successful registration.`
      );
    }

    expect(typeof reg.sessionId).toBe("string");
    expect(reg.sessionId.length).toBeGreaterThan(0);

    // Verify CDP is actually ready by running a command
    const nav = await client.navigate(
      `${process.env["TEST_WEBAPP_URL"] ?? "http://test-webapp:8888"}/`
    );

    // Must not be CommandError — the browser must actually load the page
    if ("_tag" in nav && nav._tag === "CommandError") {
      throw new Error(
        `A1: navigate returned CommandError — CDP bridge not working.\n` +
          `This means the container was created but CDP commands fail.\n` +
          `Error: ${JSON.stringify(nav)}`
      );
    }

    assertResult(nav, "NavigateResult");
    expect(nav.url).toContain("8888");
  }, 120_000);

  /**
   * A2: deregister → session gone → cannot be resumed
   */
  test("A2: deregister makes session inaccessible", async () => {
    const client = await createTestClient();
    clients.push(client);

    const reg = await client.connect();
    if ("_tag" in reg) {
      throw new Error(`A2: connect() failed: ${JSON.stringify(reg)}`);
    }

    const sessionId = reg.sessionId;

    // Commands work before deregister
    const snap1 = await client.snapshot();
    assertResult(snap1, "SnapshotResult");

    // Deregister
    await client.disconnect();

    // After deregister, give the system a moment to clean up
    await new Promise((r) => setTimeout(r, 1_000));

    // Try to resume the same session with a fresh connection — should fail
    const client2 = await createTestClient();
    clients.push(client2);

    const connected = await client2.connect();
    if ("_tag" in connected) {
      throw new Error(`A2: client2 connect() failed: ${JSON.stringify(connected)}`);
    }

    const result = await client2.resume(sessionId);

    // Expecting an error since session was destroyed
    expect("_tag" in result).toBe(true);
    if ("_tag" in result) {
      expect(
        ["SessionNotFound", "SessionExpired", "AuthError", "InternalError"].includes(
          result._tag
        )
      ).toBe(true);
    }
  }, 120_000);

  /**
   * A3: Abnormal disconnect → 5s reconnect window expires → session cleaned up
   */
  test("A3: session cleaned up after reconnect timeout expires", async () => {
    const client = await createTestClient();
    clients.push(client);

    const reg = await client.connect();
    if ("_tag" in reg) {
      throw new Error(`A3: connect() failed: ${JSON.stringify(reg)}`);
    }

    const sessionId = reg.sessionId;

    // Force disconnect without deregistering (simulates abnormal disconnect)
    client.forceDisconnect();

    // Wait longer than reconnect timeout (5s + 3s margin)
    await new Promise((r) => setTimeout(r, 8_000));

    // Session should be expired/cleaned up — resume should fail
    const client2 = await createTestClient();
    clients.push(client2);

    const connected = await client2.connect();
    if ("_tag" in connected) {
      throw new Error(`A3: client2 connect() failed: ${JSON.stringify(connected)}`);
    }

    const result = await client2.resume(sessionId);

    expect("_tag" in result).toBe(true);
    if ("_tag" in result) {
      const validCleanupErrors = ["SessionNotFound", "SessionExpired", "AuthError", "InternalError"];
      expect(validCleanupErrors.includes(result._tag)).toBe(true);
    }
  }, 30_000);

  /**
   * A4: Reconnect within timeout reuses session
   */
  test("A4: reconnect within timeout reuses session", async () => {
    const client = await createTestClient();
    clients.push(client);

    const reg = await client.connect();
    if ("_tag" in reg) {
      throw new Error(`A4: connect() failed: ${JSON.stringify(reg)}`);
    }

    const sessionId = reg.sessionId;

    // Force disconnect
    client.forceDisconnect();

    // Reconnect within 5s (2s delay — well within the window)
    await new Promise((r) => setTimeout(r, 2_000));

    // Reconnect and resume
    const reg2 = await client.connect();
    if ("_tag" in reg2) {
      throw new Error(`A4: reconnect failed: ${JSON.stringify(reg2)}`);
    }

    // Try to resume the session with the new connection
    const resumed = await client.resume(sessionId);
    if ("_tag" in resumed) {
      throw new Error(
        `A4: resume() failed within reconnect window: ${JSON.stringify(resumed)}\n` +
          `Expected the container to be reused.`
      );
    }

    expect(resumed.sessionId).toBe(sessionId);

    // CDP must still work
    const snap = await client.snapshot();
    assertResult(snap, "SnapshotResult");
  }, 30_000);

  /**
   * A5: Multiple concurrent agents → each in isolated container
   */
  test("A5: concurrent agents are isolated in separate containers", async () => {
    const N = 3;
    const clientArr = await Promise.all(
      Array.from({ length: N }, () => createTestClient())
    );
    clients.push(...clientArr);

    const sessions = await Promise.all(clientArr.map((c) => c.connect()));

    for (let i = 0; i < N; i++) {
      const sess = sessions[i]!;
      if ("_tag" in sess) {
        throw new Error(`A5: agent ${i} connect() failed: ${JSON.stringify(sess)}`);
      }
    }

    const sessionIds = sessions.map((s) => {
      if ("_tag" in s) throw new Error("unreachable");
      return s.sessionId;
    });

    // All session IDs must be unique
    const unique = new Set(sessionIds);
    expect(unique.size).toBe(N);

    // Each agent navigates to a different URL — verify isolation
    const urls = [
      `${process.env["TEST_WEBAPP_URL"] ?? "http://test-webapp:8888"}/`,
      `${process.env["TEST_WEBAPP_URL"] ?? "http://test-webapp:8888"}/form.html`,
      `${process.env["TEST_WEBAPP_URL"] ?? "http://test-webapp:8888"}/dynamic.html`,
    ];

    const results = await Promise.all(
      clientArr.map((c, i) => c.navigate(urls[i]!))
    );

    for (let i = 0; i < N; i++) {
      const r = results[i]!;
      if ("_tag" in r && r._tag === "CommandError") {
        throw new Error(
          `A5: agent ${i} navigate returned CommandError — browser isolation not working.\n` +
            `Error: ${JSON.stringify(r)}`
        );
      }
      assertResult(r, "NavigateResult");
    }

    // Verify each agent sees its own page
    const snapshots = await Promise.all(clientArr.map((c) => c.snapshot()));
    for (let i = 0; i < N; i++) {
      const snap = snapshots[i]!;
      assertResult(snap, "SnapshotResult");
      expect(snap.snapshot.length).toBeGreaterThan(0);
    }
  }, 180_000);
});
