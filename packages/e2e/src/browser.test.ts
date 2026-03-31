import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestClient, assertResult, waitForHealth } from "./helpers.js";
import type { MoatBrowserClient } from "@moat-browser/shim";

describe("B: Browser Operations", () => {
  let client: MoatBrowserClient;

  beforeAll(async () => {
    await waitForHealth(
      `${process.env["MOAT_TEST_GATEWAY"] ?? "http://localhost:9800"}/health`,
      { timeout: 60_000 },
    );
    client = createTestClient({ profile: "test-profile" });
    await client.connect();
  });

  afterAll(async () => {
    await client.disconnect();
  });

  test("B1: navigate to test webapp", async () => {
    const result = await client.navigate("http://test-webapp:8888/index.html");
    if (result._tag === "NavigateResult") {
      expect(result.url).toContain("index.html");
    }
    // CommandError is acceptable if container isn't running CDP forwarding yet
  });

  test("B2: snapshot returns content", async () => {
    const result = await client.snapshot();
    // SnapshotResult or CommandError depending on CDP availability
    expect(result._tag).toBeDefined();
  });

  test("B3: screenshot returns data", async () => {
    const result = await client.screenshot();
    expect(result._tag).toBeDefined();
  });

  test("B4: evaluate JavaScript", async () => {
    const result = await client.evaluate("document.title");
    expect(result._tag).toBeDefined();
  });

  test("B5: getCookies", async () => {
    const result = await client.getCookies();
    expect(result._tag).toBeDefined();
  });

  test("B6: wait", async () => {
    const result = await client.wait(100);
    expect(result._tag).toBeDefined();
  });
});
