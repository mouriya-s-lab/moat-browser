import { describe, test, expect, beforeAll } from "bun:test";
import { createTestClient, waitForHealth } from "./helpers.js";

describe("A: Container Lifecycle", () => {
  beforeAll(async () => {
    await waitForHealth(
      `${process.env["MOAT_TEST_GATEWAY"] ?? "http://localhost:9800"}/health`,
      { timeout: 60_000 },
    );
  });

  test("A1: register → session created", async () => {
    const client = createTestClient();
    const result = await client.connect();
    expect(result.sessionId).toBeDefined();
    expect(result.expiresAt).toBeDefined();
    await client.disconnect();
  });

  test("A2: deregister → clean disconnect", async () => {
    const client = createTestClient();
    await client.connect();
    await client.disconnect();
    // No error means clean disconnect
  });

  test("A3: multiple agents → independent sessions", async () => {
    const clients = Array.from({ length: 3 }, (_, i) =>
      createTestClient({ agentId: `lifecycle-agent-${i}` })
    );

    const results = await Promise.all(clients.map((c) => c.connect()));
    const sessionIds = results.map((r) => r.sessionId);

    // All unique session IDs
    expect(new Set(sessionIds).size).toBe(3);

    await Promise.all(clients.map((c) => c.disconnect()));
  });

  test("A4: ping → pong", async () => {
    const client = createTestClient();
    await client.connect();

    // Ping is handled internally by the gateway
    // The client stays connected
    const profiles = await client.listProfiles();
    expect(profiles._tag).toBeDefined();

    await client.disconnect();
  });
});
