import { describe, it, expect } from "bun:test";
import { transitionSession } from "../session.js";
import type { SessionState, SessionEvent } from "../session.js";

// Helper to build states
const registering = (agentId = "agent-1"): SessionState => ({
  _tag: "Registering",
  agentId,
});

const creatingContainer = (agentId = "agent-1", containerId = "ctr-abc"): SessionState => ({
  _tag: "CreatingContainer",
  agentId,
  containerId,
});

const connectingCDP = (agentId = "agent-1", containerId = "ctr-abc"): SessionState => ({
  _tag: "ConnectingCDP",
  agentId,
  containerId,
});

const active = (
  agentId = "agent-1",
  sessionId = "sess-xyz",
  containerId = "ctr-abc"
): SessionState => ({ _tag: "Active", agentId, sessionId, containerId });

const reconnecting = (
  agentId = "agent-1",
  sessionId = "sess-xyz",
  containerId = "ctr-abc"
): SessionState => ({
  _tag: "Reconnecting",
  agentId,
  sessionId,
  containerId,
  disconnectedAt: new Date().toISOString(),
});

const expired = (reason: "IdleTimeout" | "ReconnectTimeout" | "ContainerCrashed" | "TokenExpired" = "IdleTimeout"): SessionState => ({
  _tag: "Expired",
  agentId: "agent-1",
  sessionId: "sess-xyz",
  reason,
});

const destroyed: SessionState = { _tag: "Destroyed" };

// ---- Valid transitions ----

describe("transitionSession — valid transitions", () => {
  it("Registering + ContainerCreated → CreatingContainer", () => {
    const result = transitionSession(registering(), { _tag: "ContainerCreated", containerId: "ctr-abc" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next._tag).toBe("CreatingContainer");
      expect((result.next as Extract<typeof result.next, { _tag: "CreatingContainer" }>).containerId).toBe("ctr-abc");
    }
  });

  it("CreatingContainer + CDPConnected → ConnectingCDP", () => {
    const result = transitionSession(creatingContainer(), { _tag: "CDPConnected", sessionId: "sess-xyz" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next._tag).toBe("ConnectingCDP");
  });

  it("ConnectingCDP + CDPConnected → Active with sessionId", () => {
    const result = transitionSession(connectingCDP(), { _tag: "CDPConnected", sessionId: "sess-xyz" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next._tag).toBe("Active");
      expect((result.next as Extract<typeof result.next, { _tag: "Active" }>).sessionId).toBe("sess-xyz");
    }
  });

  it("Active + CommandReceived → stays Active", () => {
    const state = active();
    const result = transitionSession(state, { _tag: "CommandReceived" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next).toEqual(state);
  });

  it("Active + IdleTimerFired → Expired(IdleTimeout)", () => {
    const result = transitionSession(active(), { _tag: "IdleTimerFired" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next._tag).toBe("Expired");
      expect((result.next as Extract<typeof result.next, { _tag: "Expired" }>).reason).toBe("IdleTimeout");
    }
  });

  it("Active + SocketDisconnected → Reconnecting", () => {
    const result = transitionSession(active(), { _tag: "SocketDisconnected" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next._tag).toBe("Reconnecting");
  });

  it("Active + CDPDisconnected → Expired(ContainerCrashed)", () => {
    const result = transitionSession(active(), { _tag: "CDPDisconnected" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next._tag).toBe("Expired");
      expect((result.next as Extract<typeof result.next, { _tag: "Expired" }>).reason).toBe("ContainerCrashed");
    }
  });

  it("Reconnecting + ResumeReceived → Active", () => {
    const result = transitionSession(reconnecting(), { _tag: "ResumeReceived" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next._tag).toBe("Active");
  });

  it("Reconnecting + ReconnectTimerFired → Expired(ReconnectTimeout)", () => {
    const result = transitionSession(reconnecting(), { _tag: "ReconnectTimerFired" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next._tag).toBe("Expired");
      expect((result.next as Extract<typeof result.next, { _tag: "Expired" }>).reason).toBe("ReconnectTimeout");
    }
  });

  it("Expired + CleanupComplete → Destroyed", () => {
    const result = transitionSession(expired(), { _tag: "CleanupComplete" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next._tag).toBe("Destroyed");
  });
});

// ---- Invalid transitions ----

describe("transitionSession — invalid transitions", () => {
  it("Registering + CDPConnected → error(SessionNotReady)", () => {
    const result = transitionSession(registering(), { _tag: "CDPConnected", sessionId: "s" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("SessionNotReady");
  });

  it("Active + ContainerCreated → error(SessionNotReady)", () => {
    const result = transitionSession(active(), { _tag: "ContainerCreated", containerId: "c" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("SessionNotReady");
  });

  it("Reconnecting + IdleTimerFired → error(SessionNotReady)", () => {
    const result = transitionSession(reconnecting(), { _tag: "IdleTimerFired" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("SessionNotReady");
  });

  it("Expired + CommandReceived → error(SessionNotFound)", () => {
    const result = transitionSession(expired(), { _tag: "CommandReceived" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("SessionNotFound");
  });

  it("Destroyed + any event → error(InternalError)", () => {
    const result = transitionSession(destroyed, { _tag: "CommandReceived" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("InternalError");
  });

  it("CreatingContainer + CommandReceived → error(SessionNotReady)", () => {
    const result = transitionSession(creatingContainer(), { _tag: "CommandReceived" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("SessionNotReady");
  });
});
