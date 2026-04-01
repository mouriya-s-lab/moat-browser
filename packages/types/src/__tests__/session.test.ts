import { describe, test, expect } from "bun:test";
import { transitionSession } from "../session.js";
import type { SessionState, SessionEvent } from "../session.js";

const agentId = "agent-001";
const profilePath = "/data/profiles/agent-001";
const containerId = "container-abc123";
const containerIp = "172.18.0.5";
const sessionId = "session-xyz789";

const registering: SessionState = { _tag: "Registering", agentId };

const creatingContainer: SessionState = {
  _tag: "CreatingContainer",
  agentId,
  profilePath,
};

const connectingCDP: SessionState = {
  _tag: "ConnectingCDP",
  agentId,
  profilePath,
  containerId,
  containerIp,
};

const active: SessionState = {
  _tag: "Active",
  agentId,
  profilePath,
  containerId,
  containerIp,
  sessionId,
  lastActivityAt: 1000,
};

const reconnecting: SessionState = {
  _tag: "Reconnecting",
  agentId,
  profilePath,
  containerId,
  containerIp,
  sessionId,
  reconnectDeadline: Date.now() + 5000,
};

const expired: SessionState = {
  _tag: "Expired",
  agentId,
  profilePath,
  containerId,
  sessionId,
  reason: "idle timeout",
};

describe("transitionSession", () => {
  describe("Registering state", () => {
    test("ContainerCreated → CreatingContainer", () => {
      const event: SessionEvent = {
        _tag: "ContainerCreated",
        containerId,
        containerIp,
      };
      const next = transitionSession(registering, event);
      expect(next._tag).toBe("CreatingContainer");
      if (next._tag === "CreatingContainer") {
        expect(next.agentId).toBe(agentId);
        expect(next.profilePath).toBe(`/data/profiles/${agentId}`);
      }
    });

    test("other events → no transition", () => {
      const events: SessionEvent[] = [
        { _tag: "CDPConnected", sessionId },
        { _tag: "ActivityRecorded", at: Date.now() },
        { _tag: "SocketDisconnected" },
        { _tag: "IdleTimeout" },
        { _tag: "CleanupComplete" },
      ];
      for (const event of events) {
        expect(transitionSession(registering, event)._tag).toBe("Registering");
      }
    });
  });

  describe("CreatingContainer state", () => {
    test("ContainerCreated → ConnectingCDP", () => {
      const event: SessionEvent = {
        _tag: "ContainerCreated",
        containerId,
        containerIp,
      };
      const next = transitionSession(creatingContainer, event);
      expect(next._tag).toBe("ConnectingCDP");
      if (next._tag === "ConnectingCDP") {
        expect(next.containerId).toBe(containerId);
        expect(next.containerIp).toBe(containerIp);
      }
    });
  });

  describe("ConnectingCDP state", () => {
    test("CDPConnected → Active", () => {
      const event: SessionEvent = { _tag: "CDPConnected", sessionId };
      const next = transitionSession(connectingCDP, event);
      expect(next._tag).toBe("Active");
      if (next._tag === "Active") {
        expect(next.sessionId).toBe(sessionId);
        expect(next.lastActivityAt).toBeGreaterThan(0);
      }
    });

    test("other events → no transition", () => {
      const events: SessionEvent[] = [
        { _tag: "ActivityRecorded", at: Date.now() },
        { _tag: "SocketDisconnected" },
        { _tag: "IdleTimeout" },
      ];
      for (const event of events) {
        expect(transitionSession(connectingCDP, event)._tag).toBe("ConnectingCDP");
      }
    });
  });

  describe("Active state", () => {
    test("ActivityRecorded → Active with updated timestamp", () => {
      const at = 9999;
      const next = transitionSession(active, { _tag: "ActivityRecorded", at });
      expect(next._tag).toBe("Active");
      if (next._tag === "Active") {
        expect(next.lastActivityAt).toBe(at);
      }
    });

    test("SocketDisconnected → Reconnecting", () => {
      const next = transitionSession(active, { _tag: "SocketDisconnected" });
      expect(next._tag).toBe("Reconnecting");
      if (next._tag === "Reconnecting") {
        expect(next.reconnectDeadline).toBeGreaterThan(Date.now());
      }
    });

    test("IdleTimeout → Expired", () => {
      const next = transitionSession(active, { _tag: "IdleTimeout" });
      expect(next._tag).toBe("Expired");
      if (next._tag === "Expired") {
        expect(next.reason).toContain("idle");
      }
    });

    test("CDPDisconnected → Expired", () => {
      const next = transitionSession(active, {
        _tag: "CDPDisconnected",
        reason: "target closed",
      });
      expect(next._tag).toBe("Expired");
      if (next._tag === "Expired") {
        expect(next.reason).toContain("target closed");
      }
    });

    test("ContainerCrashed → Expired", () => {
      const next = transitionSession(active, {
        _tag: "ContainerCrashed",
        reason: "OOM",
      });
      expect(next._tag).toBe("Expired");
      if (next._tag === "Expired") {
        expect(next.reason).toContain("OOM");
      }
    });

    test("unrelated events → no transition", () => {
      const events: SessionEvent[] = [
        { _tag: "ContainerCreated", containerId, containerIp },
        { _tag: "CDPConnected", sessionId },
        { _tag: "SocketReconnected" },
        { _tag: "ReconnectTimeout" },
        { _tag: "CleanupComplete" },
      ];
      for (const event of events) {
        expect(transitionSession(active, event)._tag).toBe("Active");
      }
    });
  });

  describe("Reconnecting state", () => {
    test("SocketReconnected → Active", () => {
      const next = transitionSession(reconnecting, { _tag: "SocketReconnected" });
      expect(next._tag).toBe("Active");
      if (next._tag === "Active") {
        expect(next.sessionId).toBe(sessionId);
      }
    });

    test("ReconnectTimeout → Expired", () => {
      const next = transitionSession(reconnecting, { _tag: "ReconnectTimeout" });
      expect(next._tag).toBe("Expired");
      if (next._tag === "Expired") {
        expect(next.reason).toContain("reconnect timeout");
      }
    });

    test("CDPDisconnected → Expired", () => {
      const next = transitionSession(reconnecting, {
        _tag: "CDPDisconnected",
        reason: "crashed",
      });
      expect(next._tag).toBe("Expired");
    });
  });

  describe("Expired state", () => {
    test("CleanupComplete → Destroyed", () => {
      const next = transitionSession(expired, { _tag: "CleanupComplete" });
      expect(next._tag).toBe("Destroyed");
      if (next._tag === "Destroyed") {
        expect(next.agentId).toBe(agentId);
        expect(next.sessionId).toBe(sessionId);
      }
    });

    test("other events → no transition", () => {
      const events: SessionEvent[] = [
        { _tag: "ContainerCreated", containerId, containerIp },
        { _tag: "CDPConnected", sessionId },
        { _tag: "SocketDisconnected" },
        { _tag: "IdleTimeout" },
      ];
      for (const event of events) {
        expect(transitionSession(expired, event)._tag).toBe("Expired");
      }
    });
  });

  describe("Destroyed state", () => {
    test("any event → stays Destroyed", () => {
      const destroyed: SessionState = { _tag: "Destroyed", agentId, sessionId };
      const events: SessionEvent[] = [
        { _tag: "CleanupComplete" },
        { _tag: "ContainerCreated", containerId, containerIp },
        { _tag: "CDPConnected", sessionId },
        { _tag: "SocketDisconnected" },
      ];
      for (const event of events) {
        expect(transitionSession(destroyed, event)._tag).toBe("Destroyed");
      }
    });
  });
});
