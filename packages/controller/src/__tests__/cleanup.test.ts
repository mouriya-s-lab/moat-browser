import { describe, test, expect, mock } from "bun:test";
import { CleanupScheduler } from "../cleanup.js";

// Minimal mock of ControllerServer for cleanup tests
function makeServerMock(staleSessions: Array<{ sessionId: string; state: { _tag: string } }> = []) {
  const cleaned: string[] = [];
  const registry = {
    stale: (_now: number) => staleSessions,
    all: () => new Map<string, unknown>(),
  };
  const server = {
    getRegistry: () => registry,
    _cleanupSession: async (sessionId: string) => { cleaned.push(sessionId); },
  } as unknown as import("../socketio.js").ControllerServer;

  return { server, cleaned };
}

describe("CleanupScheduler", () => {
  test("start and stop without error", () => {
    const { server } = makeServerMock();
    const scheduler = new CleanupScheduler(server);
    scheduler.start(99_999_999);
    scheduler.stop();
    // No throw = pass
    expect(true).toBe(true);
  });

  test("runNow cleans up stale sessions", async () => {
    const { server, cleaned } = makeServerMock([
      { sessionId: "s1", state: { _tag: "Expired" } },
      { sessionId: "s2", state: { _tag: "Expired" } },
    ]);
    const scheduler = new CleanupScheduler(server);
    await scheduler.runNow();
    expect(cleaned).toContain("s1");
    expect(cleaned).toContain("s2");
  });

  test("runNow does nothing when no stale sessions", async () => {
    const { server, cleaned } = makeServerMock([]);
    const scheduler = new CleanupScheduler(server);
    await scheduler.runNow();
    expect(cleaned).toHaveLength(0);
  });
});
