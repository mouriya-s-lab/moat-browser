/**
 * auth.test.ts — Scenario group C: authentication
 *
 * C1: invalid token → rejected
 * C2: expired token → rejected
 * C3: container isolation — agent A cannot access agent B's browser
 *
 * All tests require Docker Compose stack to be running.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  waitForPort,
  createTestClient,
  makeToken,
  assertError,
  TEST_GATEWAY,
} from "./helpers.js";
import { MoatBrowserClient } from "@moat-browser/shim";

const CONTROLLER_PORT = 9800;
const INFRASTRUCTURE_TIMEOUT = 60_000;

describe("Phase 9 - Scenario C: Authentication", () => {
  beforeAll(async () => {
    await waitForPort(CONTROLLER_PORT, { timeout: INFRASTRUCTURE_TIMEOUT });
  }, INFRASTRUCTURE_TIMEOUT);

  /**
   * C1: invalid token → connection rejected with AuthError
   */
  test("C1: invalid token is rejected", async () => {
    const client = new MoatBrowserClient({
      gateway: TEST_GATEWAY,
      token: "not-a-valid-jwt",
      agentId: "test-invalid-token",
    });

    const result = await client.connect();

    // Must be an error
    expect("_tag" in result).toBe(true);
    if ("_tag" in result) {
      assertError(result, "AuthError");
    }

    await client.disconnect();
  }, 15_000);

  test("C1: token signed with wrong secret is rejected", async () => {
    const token = await makeToken({
      agentId: "test-wrong-secret",
      secret: "completely-wrong-secret",
    });

    const client = new MoatBrowserClient({
      gateway: TEST_GATEWAY,
      token,
      agentId: "test-wrong-secret",
    });

    const result = await client.connect();

    expect("_tag" in result).toBe(true);
    if ("_tag" in result) {
      assertError(result, "AuthError");
    }

    await client.disconnect();
  }, 15_000);

  test("C1: empty token is rejected", async () => {
    const client = new MoatBrowserClient({
      gateway: TEST_GATEWAY,
      token: "",
      agentId: "test-empty-token",
    });

    const result = await client.connect();

    expect("_tag" in result).toBe(true);
    if ("_tag" in result) {
      assertError(result, "AuthError");
    }

    await client.disconnect();
  }, 15_000);

  /**
   * C2: expired token → connection rejected with AuthError
   */
  test("C2: expired token is rejected", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await makeToken({
      agentId: "test-expired",
      iat: now - 7200, // issued 2 hours ago
      exp: now - 3600, // expired 1 hour ago
    });

    const client = new MoatBrowserClient({
      gateway: TEST_GATEWAY,
      token,
      agentId: "test-expired",
    });

    const result = await client.connect();

    expect("_tag" in result).toBe(true);
    if ("_tag" in result) {
      assertError(result, "AuthError");
    }

    await client.disconnect();
  }, 15_000);

  /**
   * C3: container isolation — agent A cannot access agent B's session
   */
  test("C3: agent A cannot resume agent B's session", async () => {
    const clientA = await createTestClient({ agentId: "isolation-agent-a" });
    const clientB = await createTestClient({ agentId: "isolation-agent-b" });

    // Connect agent A
    const regA = await clientA.connect();
    if ("_tag" in regA) {
      throw new Error(`C3: agent A connect failed: ${JSON.stringify(regA)}`);
    }

    // Connect agent B
    const regB = await clientB.connect();
    if ("_tag" in regB) {
      await clientA.disconnect();
      throw new Error(`C3: agent B connect failed: ${JSON.stringify(regB)}`);
    }

    const sessionB = regB.sessionId;

    // Agent A tries to resume agent B's session
    // A's token has agentId="isolation-agent-a" but session belongs to agent B
    const result = await clientA.resume(sessionB);

    // Must be rejected — agent A should not be able to access agent B's session
    expect("_tag" in result).toBe(true);
    if ("_tag" in result) {
      const validIsolationErrors = ["AuthError", "SessionNotFound", "InternalError"];
      const errorTag = result._tag;
      if (!validIsolationErrors.includes(errorTag)) {
        throw new Error(
          `C3: Expected AuthError or SessionNotFound but got ${errorTag}.\n` +
            `Agent A must not be able to access Agent B's session.\n` +
            `Full error: ${JSON.stringify(result)}`
        );
      }
    }

    await clientA.disconnect();
    await clientB.disconnect();
  }, 60_000);
});
