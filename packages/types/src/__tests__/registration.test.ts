import { describe, test, expect } from "bun:test";
import { transitionSession, TokenPayloadSchema } from "../registration.js";
import type { SessionState, SessionEvent } from "../registration.js";

describe("transitionSession", () => {
  const registering: SessionState = { _tag: "Registering", agentId: "a1", profileName: "p1" };

  // Registering → Active
  test("Registering + ContainerReady → Active", () => {
    const next = transitionSession(registering, { _tag: "ContainerReady", containerId: "c1" });
    expect(next._tag).toBe("Active");
    if (next._tag === "Active") {
      expect(next.agentId).toBe("a1");
      expect(next.containerId).toBe("c1");
    }
  });

  // Registering + ContainerCrashed → Expired
  test("Registering + ContainerCrashed → Expired", () => {
    const next = transitionSession(registering, { _tag: "ContainerCrashed", exitCode: 1 });
    expect(next._tag).toBe("Expired");
  });

  // Registering + DeregisterRequested → Destroyed
  test("Registering + DeregisterRequested → Destroyed", () => {
    const next = transitionSession(registering, { _tag: "DeregisterRequested" });
    expect(next._tag).toBe("Destroyed");
  });

  // Registering + irrelevant event → no change
  test("Registering + CommandReceived → stays Registering", () => {
    const next = transitionSession(registering, { _tag: "CommandReceived" });
    expect(next._tag).toBe("Registering");
  });

  // Active state
  const active: SessionState = { _tag: "Active", agentId: "a1", sessionId: "s1", containerId: "c1" };

  test("Active + CommandCompleted → Idle", () => {
    const next = transitionSession(active, { _tag: "CommandCompleted" });
    expect(next._tag).toBe("Idle");
  });

  test("Active + Disconnected → Reconnecting", () => {
    const next = transitionSession(active, { _tag: "Disconnected" });
    expect(next._tag).toBe("Reconnecting");
  });

  test("Active + IdleTimedOut → Expired(IdleTimeout)", () => {
    const next = transitionSession(active, { _tag: "IdleTimedOut", idleDuration: 3600 });
    expect(next._tag).toBe("Expired");
    if (next._tag === "Expired") expect(next.reason._tag).toBe("IdleTimeout");
  });

  test("Active + TokenExpired → Expired(TokenExpired)", () => {
    const next = transitionSession(active, { _tag: "TokenExpired" });
    expect(next._tag).toBe("Expired");
    if (next._tag === "Expired") expect(next.reason._tag).toBe("TokenExpired");
  });

  test("Active + BudgetExhausted → Expired(BudgetExhausted)", () => {
    const next = transitionSession(active, { _tag: "BudgetExhausted", limit: "1000/h" });
    expect(next._tag).toBe("Expired");
    if (next._tag === "Expired") expect(next.reason._tag).toBe("BudgetExhausted");
  });

  test("Active + ContainerCrashed → Expired(ContainerCrashed)", () => {
    const next = transitionSession(active, { _tag: "ContainerCrashed", exitCode: 137 });
    expect(next._tag).toBe("Expired");
    if (next._tag === "Expired") expect(next.reason._tag).toBe("ContainerCrashed");
  });

  test("Active + DeregisterRequested → Expired(ManualDeregister)", () => {
    const next = transitionSession(active, { _tag: "DeregisterRequested" });
    expect(next._tag).toBe("Expired");
    if (next._tag === "Expired") expect(next.reason._tag).toBe("ManualDeregister");
  });

  test("Active + ForceReplace → Expired(ForceReplaced)", () => {
    const next = transitionSession(active, { _tag: "ForceReplace", newSessionId: "s2" });
    expect(next._tag).toBe("Expired");
    if (next._tag === "Expired") expect(next.reason._tag).toBe("ForceReplaced");
  });

  test("Active + CommandReceived → stays Active", () => {
    const next = transitionSession(active, { _tag: "CommandReceived" });
    expect(next._tag).toBe("Active");
  });

  // Idle state
  const idle: SessionState = { _tag: "Idle", agentId: "a1", sessionId: "s1", idleSince: "2026-01-01" };

  test("Idle + CommandReceived → Active", () => {
    const next = transitionSession(idle, { _tag: "CommandReceived" });
    expect(next._tag).toBe("Active");
  });

  test("Idle + Disconnected → Reconnecting", () => {
    const next = transitionSession(idle, { _tag: "Disconnected" });
    expect(next._tag).toBe("Reconnecting");
  });

  test("Idle + IdleTimedOut → Expired", () => {
    const next = transitionSession(idle, { _tag: "IdleTimedOut", idleDuration: 3600 });
    expect(next._tag).toBe("Expired");
  });

  // Reconnecting state
  const reconnecting: SessionState = { _tag: "Reconnecting", agentId: "a1", sessionId: "s1", disconnectedAt: "2026-01-01" };

  test("Reconnecting + Reconnected → Active", () => {
    const next = transitionSession(reconnecting, { _tag: "Reconnected", socketId: "sock1" });
    expect(next._tag).toBe("Active");
  });

  test("Reconnecting + ReconnectTimedOut → Expired(ReconnectTimeout)", () => {
    const next = transitionSession(reconnecting, { _tag: "ReconnectTimedOut" });
    expect(next._tag).toBe("Expired");
    if (next._tag === "Expired") expect(next.reason._tag).toBe("ReconnectTimeout");
  });

  // Expired → Destroyed
  const expired: SessionState = { _tag: "Expired", agentId: "a1", sessionId: "s1", reason: { _tag: "ManualDeregister" } };

  test("Expired + any event → Destroyed", () => {
    const next = transitionSession(expired, { _tag: "CommandReceived" });
    expect(next._tag).toBe("Destroyed");
  });

  // Destroyed is terminal
  const destroyed: SessionState = { _tag: "Destroyed" };

  test("Destroyed + any event → stays Destroyed", () => {
    const next = transitionSession(destroyed, { _tag: "ContainerReady", containerId: "c1" });
    expect(next._tag).toBe("Destroyed");
  });
});

describe("TokenPayloadSchema", () => {
  const validPayload = {
    sub: "agent:sales-bot",
    iss: "moat-browser",
    aud: "moat-browser-gateway",
    exp: 1800000000,
    iat: 1700000000,
    permissions: {
      profiles: ["corp-salesforce"],
      maxSessions: 3,
    },
  };

  test("accepts valid payload", () => {
    const r = TokenPayloadSchema(validPayload);
    expect(r instanceof Array).toBe(false);
  });

  test("accepts with optional fields", () => {
    const r = TokenPayloadSchema({
      ...validPayload,
      permissions: {
        ...validPayload.permissions,
        allowedDomains: ["salesforce.com"],
        budget: { maxNavigations: 100, maxActions: 500 },
      },
    });
    expect(r instanceof Array).toBe(false);
  });

  test("rejects invalid sub prefix", () => {
    const r = TokenPayloadSchema({ ...validPayload, sub: "user:bob" });
    expect(r instanceof Array).toBe(true);
  });

  test("rejects wrong iss", () => {
    const r = TokenPayloadSchema({ ...validPayload, iss: "other" });
    expect(r instanceof Array).toBe(true);
  });

  test("rejects empty profiles", () => {
    const r = TokenPayloadSchema({
      ...validPayload,
      permissions: { ...validPayload.permissions, profiles: [] },
    });
    expect(r instanceof Array).toBe(true);
  });

  test("rejects maxSessions > 10", () => {
    const r = TokenPayloadSchema({
      ...validPayload,
      permissions: { ...validPayload.permissions, maxSessions: 11 },
    });
    expect(r instanceof Array).toBe(true);
  });

  test("rejects maxSessions < 1", () => {
    const r = TokenPayloadSchema({
      ...validPayload,
      permissions: { ...validPayload.permissions, maxSessions: 0 },
    });
    expect(r instanceof Array).toBe(true);
  });
});
