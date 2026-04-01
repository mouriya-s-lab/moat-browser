/**
 * config.test.ts — Tests for config defaults
 */

import { describe, test, expect } from "bun:test";
import { config } from "../config.js";

describe("config", () => {
  test("defaults are set", () => {
    expect(typeof config.gateway).toBe("string");
    expect(typeof config.token).toBe("string");
    expect(typeof config.agentId).toBe("string");
    expect(typeof config.socket).toBe("string");
  });

  test("gateway default is localhost:9900", () => {
    // Only check if the env var is not set
    if (!process.env["MOAT_BROWSER_GATEWAY"]) {
      expect(config.gateway).toBe("http://localhost:9900");
    }
  });

  test("socket default is /run/agent-browser/main.sock", () => {
    if (!process.env["MOAT_BROWSER_SOCKET"]) {
      expect(config.socket).toBe("/run/agent-browser/main.sock");
    }
  });
});
