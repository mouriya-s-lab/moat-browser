import { describe, test, expect } from "bun:test";
import type {
  ContainerInfo,
  ContainerSummary,
} from "../docker.js";
import {
  createAgentChrome,
  destroyAgentChrome,
  inspectContainer,
  getContainerIp,
  listContainers,
  waitForCDP,
} from "../docker.js";

describe("docker module exports", () => {
  test("all functions are exported", () => {
    expect(typeof createAgentChrome).toBe("function");
    expect(typeof destroyAgentChrome).toBe("function");
    expect(typeof inspectContainer).toBe("function");
    expect(typeof getContainerIp).toBe("function");
    expect(typeof listContainers).toBe("function");
    expect(typeof waitForCDP).toBe("function");
  });
});

describe("waitForCDP", () => {
  test("throws when timeout is 0ms", async () => {
    // Port 19222 is almost certainly not listening, so this should time out
    await expect(
      waitForCDP("127.0.0.1", 19222, 0)
    ).rejects.toThrow("did not become ready within 0ms");
  });

  test("throws with timeout message when host is unreachable", async () => {
    await expect(
      waitForCDP("127.0.0.1", 19222, 200)
    ).rejects.toThrow("did not become ready within 200ms");
  });
});
