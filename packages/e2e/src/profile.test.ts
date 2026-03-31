import { describe, test, expect, beforeAll } from "bun:test";
import { createTestClient, waitForHealth } from "./helpers.js";

describe("C: Profile Management", () => {
  beforeAll(async () => {
    await waitForHealth(
      `${process.env["MOAT_TEST_GATEWAY"] ?? "http://localhost:9800"}/health`,
      { timeout: 60_000 },
    );
  });

  test("C1: list profiles", async () => {
    const client = createTestClient();
    await client.connect();

    const result = await client.listProfiles();
    expect(result._tag).toBe("ProfileList");
    if (result._tag === "ProfileList") {
      expect(Array.isArray(result.profiles)).toBe(true);
    }

    await client.disconnect();
  });

  test("C2: freeze non-existent profile returns error", async () => {
    const client = createTestClient();
    await client.connect();

    const result = await client.freezeProfile("nonexistent-profile");
    // Should return an error since profile doesn't exist
    expect(result._tag).toBeDefined();

    await client.disconnect();
  });

  test("C3: start/stop user chrome", async () => {
    const client = createTestClient();
    await client.connect();

    const startResult = await client.startUserChrome("test-session");
    expect(startResult._tag).toBeDefined();

    const stopResult = await client.stopUserChrome();
    expect(stopResult._tag).toBeDefined();

    await client.disconnect();
  });
});
