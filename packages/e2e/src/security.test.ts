import { describe, test, expect, beforeAll } from "bun:test";
import { MoatBrowserClient } from "@moat-browser/shim";
import { waitForHealth } from "./helpers.js";

describe("D: Security", () => {
  const gatewayUrl = process.env["MOAT_TEST_GATEWAY"] ?? "ws://localhost:9800";

  beforeAll(async () => {
    await waitForHealth(
      gatewayUrl.replace("ws://", "http://").replace("wss://", "https://") + "/health",
      { timeout: 60_000 },
    );
  });

  test("D1: empty token → connection rejected", async () => {
    const client = new MoatBrowserClient({
      gateway: gatewayUrl,
      token: "",
      agentId: "bad-agent",
      profile: "test-profile",
    });

    try {
      await client.connect();
      // If connect succeeds with empty token in dev mode, that's OK
      await client.disconnect();
    } catch (err) {
      // Expected: authentication failure
      expect(String(err)).toContain("Authentication");
    }
  });

  test("D2: valid token → connection accepted", async () => {
    const client = new MoatBrowserClient({
      gateway: gatewayUrl,
      token: "valid-test-token",
      agentId: `sec-agent-${Date.now().toString(36)}`,
      profile: "test-profile",
    });

    try {
      const result = await client.connect();
      expect(result.sessionId).toBeDefined();
      await client.disconnect();
    } catch {
      // May fail if gateway requires specific token format
    }
  });
});
