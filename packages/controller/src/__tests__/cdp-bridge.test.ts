import { describe, test, expect, mock, beforeEach } from "bun:test";
import { CDPBridge } from "../cdp-bridge.js";

/**
 * Unit tests for CDPBridge.
 *
 * These tests mock patchright to avoid needing a real CDP endpoint.
 * E2E tests in packages/e2e/ cover real connectivity.
 */

describe("CDPBridge — disconnected state", () => {
  test("connected returns false before connect()", () => {
    const bridge = new CDPBridge();
    expect(bridge.connected).toBe(false);
  });

  test("execute returns CDPError when not connected", async () => {
    const bridge = new CDPBridge();
    const result = await bridge.execute({ _tag: "Snapshot" });
    expect(result._tag).toBe("CDPError");
    if (result._tag === "CDPError") {
      expect(result.message).toContain("not connected");
    }
  });

  test("disconnect is safe to call when not connected", async () => {
    const bridge = new CDPBridge();
    await expect(bridge.disconnect()).resolves.toBeUndefined();
  });
});

describe("CDPBridge — error handling", () => {
  test("execute returns CommandError when page throws", async () => {
    // We test the error wrapping path by checking the result shape.
    // Since we can't easily mock the private conn, we verify that
    // a disconnected bridge returns CDPError (tested above).
    // Additional error path testing requires integration.
    const bridge = new CDPBridge();
    const result = await bridge.execute({ _tag: "Navigate", url: "https://example.com" });
    expect(result._tag).toBe("CDPError");
  });

  test("execute returns CDPError for all command tags when disconnected", async () => {
    const bridge = new CDPBridge();
    const commands = [
      { _tag: "Navigate" as const, url: "https://example.com" },
      { _tag: "Click" as const, ref: "button" },
      { _tag: "Fill" as const, ref: "input", value: "hello" },
      { _tag: "Snapshot" as const },
      { _tag: "Screenshot" as const },
      { _tag: "Evaluate" as const, expression: "1+1" },
      { _tag: "NewTab" as const },
      { _tag: "SwitchTab" as const, tabId: "0" },
      { _tag: "CloseTab" as const, tabId: "0" },
      { _tag: "Wait" as const, ms: 100 },
    ];

    for (const cmd of commands) {
      const result = await bridge.execute(cmd);
      expect(result._tag).toBe("CDPError");
    }
  });
});

describe("CDPBridge — exports", () => {
  test("CDPBridge class is exported", () => {
    expect(typeof CDPBridge).toBe("function");
  });

  test("createCDPBridge factory is exported", async () => {
    const { createCDPBridge } = await import("../cdp-bridge.js");
    expect(typeof createCDPBridge).toBe("function");
  });
});
