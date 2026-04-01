import { describe, test, expect } from "bun:test";
import { SessionRegistry } from "../session-registry.js";

describe("SessionRegistry", () => {
  test("create returns a new sessionId and Registering state", () => {
    const registry = new SessionRegistry();
    const { sessionId, state } = registry.create("agent-1");
    expect(typeof sessionId).toBe("string");
    expect(state._tag).toBe("Registering");
    expect(state.agentId).toBe("agent-1");
  });

  test("get returns state for known sessionId", () => {
    const registry = new SessionRegistry();
    const { sessionId } = registry.create("agent-2");
    const state = registry.get(sessionId);
    expect(state).toBeDefined();
    expect(state?._tag).toBe("Registering");
  });

  test("get returns undefined for unknown sessionId", () => {
    const registry = new SessionRegistry();
    expect(registry.get("unknown")).toBeUndefined();
  });

  test("getSessionIdByAgent returns sessionId", () => {
    const registry = new SessionRegistry();
    const { sessionId } = registry.create("agent-3");
    expect(registry.getSessionIdByAgent("agent-3")).toBe(sessionId);
  });

  test("dispatch applies state transition", () => {
    const registry = new SessionRegistry();
    const { sessionId } = registry.create("agent-4");
    // Drive Registering → CreatingContainer
    registry.dispatch(sessionId, { _tag: "ContainerCreated", containerId: "", containerIp: "" });
    const state = registry.get(sessionId);
    expect(state?._tag).toBe("CreatingContainer");
  });

  test("dispatch on unknown session returns undefined", () => {
    const registry = new SessionRegistry();
    const result = registry.dispatch("ghost", { _tag: "CleanupComplete" });
    expect(result).toBeUndefined();
  });

  test("delete removes session and agent mapping", () => {
    const registry = new SessionRegistry();
    const { sessionId } = registry.create("agent-5");
    registry.delete(sessionId);
    expect(registry.get(sessionId)).toBeUndefined();
    expect(registry.getSessionIdByAgent("agent-5")).toBeUndefined();
  });

  test("stale returns idle Active sessions", () => {
    const registry = new SessionRegistry();
    const { sessionId } = registry.create("agent-6");
    // Drive to Active state
    registry.dispatch(sessionId, { _tag: "ContainerCreated", containerId: "", containerIp: "" });
    registry.dispatch(sessionId, { _tag: "ContainerCreated", containerId: "c1", containerIp: "10.0.0.1" });
    registry.dispatch(sessionId, { _tag: "CDPConnected", sessionId });

    const state = registry.get(sessionId);
    expect(state?._tag).toBe("Active");

    // With far future "now" — session should be idle
    const farFuture = Date.now() + 99_999_999;
    const stale = registry.stale(farFuture);
    expect(stale.some((s) => s.sessionId === sessionId)).toBe(true);
  });

  test("stale returns Reconnecting sessions past deadline", () => {
    const registry = new SessionRegistry();
    const { sessionId } = registry.create("agent-7");
    registry.dispatch(sessionId, { _tag: "ContainerCreated", containerId: "", containerIp: "" });
    registry.dispatch(sessionId, { _tag: "ContainerCreated", containerId: "c2", containerIp: "10.0.0.2" });
    registry.dispatch(sessionId, { _tag: "CDPConnected", sessionId });
    registry.dispatch(sessionId, { _tag: "SocketDisconnected" });

    const state = registry.get(sessionId);
    expect(state?._tag).toBe("Reconnecting");

    // Past the reconnect deadline
    const farFuture = Date.now() + 99_999_999;
    const stale = registry.stale(farFuture);
    expect(stale.some((s) => s.sessionId === sessionId)).toBe(true);
  });
});
