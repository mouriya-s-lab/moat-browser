import { describe, it, expect, beforeEach } from "bun:test";
import {
  createSession,
  getSession,
  applyEvent,
  deleteSession,
  listSessions,
  setIdleTimer,
  clearIdleTimer,
} from "../session.js";

// Reset registry state between tests by deleting created sessions
let createdSessions: string[] = [];

beforeEach(() => {
  for (const id of createdSessions) {
    deleteSession(id);
  }
  createdSessions = [];
});

function track(sessionId: string): string {
  createdSessions.push(sessionId);
  return sessionId;
}

describe("SessionRegistry — CRUD", () => {
  it("createSession returns a UUID and stores Registering state", () => {
    const id = track(createSession("agent-1"));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const entry = getSession(id);
    expect(entry).toBeDefined();
    expect(entry!.state._tag).toBe("Registering");
    expect((entry!.state as { agentId: string }).agentId).toBe("agent-1");
  });

  it("getSession returns undefined for unknown id", () => {
    expect(getSession("no-such-id")).toBeUndefined();
  });

  it("deleteSession removes the entry", () => {
    const id = createSession("agent-2");
    deleteSession(id);
    expect(getSession(id)).toBeUndefined();
  });

  it("listSessions includes created session", () => {
    const id = track(createSession("agent-3"));
    const list = listSessions();
    expect(list.some((s) => s.sessionId === id && s.stateTag === "Registering")).toBe(true);
  });
});

describe("SessionRegistry — state transitions via applyEvent", () => {
  it("applyEvent ContainerCreated → CreatingContainer", () => {
    const id = track(createSession("agent-4"));
    const result = applyEvent(id, { _tag: "ContainerCreated", containerId: "ctr-123" });
    expect(result.ok).toBe(true);
    expect(getSession(id)!.state._tag).toBe("CreatingContainer");
  });

  it("applyEvent on unknown session → SessionNotFound error", () => {
    const result = applyEvent("ghost-session", { _tag: "CommandReceived" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("SessionNotFound");
  });

  it("full lifecycle: Registering → CreatingContainer → ConnectingCDP → Active → Expired → Destroyed", () => {
    const id = track(createSession("agent-5"));

    // → CreatingContainer
    let r = applyEvent(id, { _tag: "ContainerCreated", containerId: "ctr-abc" });
    expect(r.ok).toBe(true);
    expect(getSession(id)!.state._tag).toBe("CreatingContainer");

    // → ConnectingCDP
    r = applyEvent(id, { _tag: "CDPConnected", sessionId: "sess-abc" });
    expect(r.ok).toBe(true);
    expect(getSession(id)!.state._tag).toBe("ConnectingCDP");

    // → Active
    r = applyEvent(id, { _tag: "CDPConnected", sessionId: "sess-abc" });
    expect(r.ok).toBe(true);
    expect(getSession(id)!.state._tag).toBe("Active");

    // → Expired via IdleTimerFired
    r = applyEvent(id, { _tag: "IdleTimerFired" });
    expect(r.ok).toBe(true);
    expect(getSession(id)!.state._tag).toBe("Expired");

    // → Destroyed
    r = applyEvent(id, { _tag: "CleanupComplete" });
    expect(r.ok).toBe(true);
    expect(getSession(id)!.state._tag).toBe("Destroyed");
  });

  it("Active → Reconnecting → Active (resume path)", () => {
    const id = track(createSession("agent-6"));
    applyEvent(id, { _tag: "ContainerCreated", containerId: "ctr-r" });
    applyEvent(id, { _tag: "CDPConnected", sessionId: "sess-r" });
    applyEvent(id, { _tag: "CDPConnected", sessionId: "sess-r" });
    // now Active
    expect(getSession(id)!.state._tag).toBe("Active");

    applyEvent(id, { _tag: "SocketDisconnected" });
    expect(getSession(id)!.state._tag).toBe("Reconnecting");

    applyEvent(id, { _tag: "ResumeReceived" });
    expect(getSession(id)!.state._tag).toBe("Active");
  });
});

describe("SessionRegistry — timers", () => {
  it("setIdleTimer fires callback after delay", async () => {
    const id = track(createSession("agent-7"));
    let fired = false;
    setIdleTimer(id, 50, () => { fired = true; });
    await new Promise((r) => setTimeout(r, 100));
    expect(fired).toBe(true);
  });

  it("clearIdleTimer prevents callback", async () => {
    const id = track(createSession("agent-8"));
    let fired = false;
    setIdleTimer(id, 50, () => { fired = true; });
    clearIdleTimer(id);
    await new Promise((r) => setTimeout(r, 100));
    expect(fired).toBe(false);
  });
});
