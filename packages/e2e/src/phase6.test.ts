import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { io, type Socket } from "socket.io-client";
import { connect, type BrowserClient } from "@moat-browser/shim";
import { TEST_CONFIG, createTestToken } from "./helpers";
import { ensureEnvironment } from "./setup";

describe("Phase 6: shim SDK", () => {
  let client: BrowserClient | undefined;

  beforeAll(async () => {
    await ensureEnvironment();

    // Ensure profile is frozen for agent registration
    const socket = io(TEST_CONFIG.controllerUrl, {
      autoConnect: false,
      timeout: 10000,
    });
    await new Promise<void>((resolve) => {
      socket.on("connect", () => resolve());
      socket.connect();
    });
    // Unfreeze then freeze to ensure clean state
    await new Promise<unknown>((r) => socket.emit("unfreezeProfile", r)).catch(
      () => {}
    );
    await new Promise<unknown>((r) => socket.emit("freezeProfile", r));
    socket.disconnect();
  });

  afterAll(async () => {
    if (client) {
      await client.disconnect();
    }
    // Unfreeze for cleanup
    const socket = io(TEST_CONFIG.controllerUrl, {
      autoConnect: false,
      timeout: 10000,
    });
    await new Promise<void>((resolve) => {
      socket.on("connect", () => resolve());
      socket.connect();
    });
    await new Promise<unknown>((r) => socket.emit("unfreezeProfile", r)).catch(
      () => {}
    );
    socket.disconnect();
  });

  test("connect() returns BrowserClient", async () => {
    const token = createTestToken("e2e-agent-phase6");
    const result = await connect(TEST_CONFIG.controllerUrl, token);
    if ("_tag" in result) {
      throw new Error(`connect failed: ${JSON.stringify(result)}`);
    }
    client = result;
    expect(client.sessionId).toBeDefined();
    expect(typeof client.sessionId).toBe("string");
  }, 60000);

  test("navigate returns NavigateResult", async () => {
    if (!client) throw new Error("No client");
    const result = await client.navigate(TEST_CONFIG.webappUrl);
    if ("_tag" in result && result._tag !== "NavigateResult") {
      throw new Error(`navigate failed: ${JSON.stringify(result)}`);
    }
    expect(result._tag).toBe("NavigateResult");
    if (result._tag === "NavigateResult") {
      expect(result.title).toBe("Moat Test Page");
    }
  }, 30000);

  test("click returns ClickResult", async () => {
    if (!client) throw new Error("No client");
    // Fill username first so click has something visible
    await client.fill("#username", "e2e-user");
    const result = await client.click("#login-btn");
    expect(result._tag).toBe("ClickResult");
  }, 30000);

  test("fill returns FillResult", async () => {
    if (!client) throw new Error("No client");
    const result = await client.fill("#username", "test-value");
    expect(result._tag).toBe("FillResult");
  }, 30000);

  test("snapshot returns SnapshotResult", async () => {
    if (!client) throw new Error("No client");
    const result = await client.snapshot();
    expect(result._tag).toBe("SnapshotResult");
    if (result._tag === "SnapshotResult") {
      expect(result.aria.length).toBeGreaterThan(0);
    }
  }, 30000);

  test("screenshot returns ScreenshotResult", async () => {
    if (!client) throw new Error("No client");
    const result = await client.screenshot();
    expect(result._tag).toBe("ScreenshotResult");
    if (result._tag === "ScreenshotResult") {
      expect(result.png.length).toBeGreaterThan(0);
    }
  }, 30000);

  test("evaluate returns EvaluateResult", async () => {
    if (!client) throw new Error("No client");
    const result = await client.evaluate("document.title");
    expect(result._tag).toBe("EvaluateResult");
    if (result._tag === "EvaluateResult") {
      expect(result.value).toBe("Moat Test Page");
    }
  }, 30000);

  test("wait returns WaitResult", async () => {
    if (!client) throw new Error("No client");
    const result = await client.wait("#title", 5000);
    expect(result._tag).toBe("WaitResult");
  }, 30000);

  test("disconnect succeeds", async () => {
    if (!client) throw new Error("No client");
    await client.disconnect();
    client = undefined;
  }, 30000);
});
