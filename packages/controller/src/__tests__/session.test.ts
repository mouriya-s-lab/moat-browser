import { describe, test, expect } from "bun:test";
import {
  transitionSession,
  type SessionState,
  type SessionEvent,
} from "@moat-browser/types";

describe("transitionSession", () => {
  // Happy path: full lifecycle
  test("Registering + StartCreating → CreatingContainer", () => {
    const result = transitionSession(
      { _tag: "Registering" },
      { _tag: "StartCreating" }
    );
    expect(result._tag).toBe("CreatingContainer");
  });

  test("CreatingContainer + ContainerCreated → ConnectingCDP", () => {
    const result = transitionSession(
      { _tag: "CreatingContainer" },
      { _tag: "ContainerCreated" }
    );
    expect(result._tag).toBe("ConnectingCDP");
  });

  test("ConnectingCDP + CdpConnected → Active", () => {
    const result = transitionSession(
      { _tag: "ConnectingCDP" },
      { _tag: "CdpConnected" }
    );
    expect(result._tag).toBe("Active");
  });

  // Active state transitions
  test("Active + IdleTimeout → Expired", () => {
    const result = transitionSession(
      { _tag: "Active" },
      { _tag: "IdleTimeout" }
    );
    expect(result._tag).toBe("Expired");
  });

  test("Active + CdpDisconnected → Expired", () => {
    const result = transitionSession(
      { _tag: "Active" },
      { _tag: "CdpDisconnected" }
    );
    expect(result._tag).toBe("Expired");
  });

  test("Active + SocketDisconnected → Reconnecting", () => {
    const result = transitionSession(
      { _tag: "Active" },
      { _tag: "SocketDisconnected" }
    );
    expect(result._tag).toBe("Reconnecting");
  });

  // Reconnecting state transitions
  test("Reconnecting + SocketReconnected → Active", () => {
    const result = transitionSession(
      { _tag: "Reconnecting" },
      { _tag: "SocketReconnected" }
    );
    expect(result._tag).toBe("Active");
  });

  test("Reconnecting + ReconnectTimeout → Expired", () => {
    const result = transitionSession(
      { _tag: "Reconnecting" },
      { _tag: "ReconnectTimeout" }
    );
    expect(result._tag).toBe("Expired");
  });

  // Error from any non-terminal state → Expired
  test("Registering + Error → Expired", () => {
    const result = transitionSession(
      { _tag: "Registering" },
      { _tag: "Error", message: "fail" }
    );
    expect(result._tag).toBe("Expired");
  });

  test("CreatingContainer + Error → Expired", () => {
    const result = transitionSession(
      { _tag: "CreatingContainer" },
      { _tag: "Error", message: "fail" }
    );
    expect(result._tag).toBe("Expired");
  });

  test("ConnectingCDP + Error → Expired", () => {
    const result = transitionSession(
      { _tag: "ConnectingCDP" },
      { _tag: "Error", message: "fail" }
    );
    expect(result._tag).toBe("Expired");
  });

  test("Active + Error → Expired", () => {
    const result = transitionSession(
      { _tag: "Active" },
      { _tag: "Error", message: "fail" }
    );
    expect(result._tag).toBe("Expired");
  });

  test("Reconnecting + Error → Expired", () => {
    const result = transitionSession(
      { _tag: "Reconnecting" },
      { _tag: "Error", message: "fail" }
    );
    expect(result._tag).toBe("Expired");
  });

  // Expired rejects all events
  test("Expired rejects all events", () => {
    const events: SessionEvent[] = [
      { _tag: "StartCreating" },
      { _tag: "ContainerCreated" },
      { _tag: "CdpConnected" },
      { _tag: "IdleTimeout" },
      { _tag: "CdpDisconnected" },
      { _tag: "SocketDisconnected" },
      { _tag: "SocketReconnected" },
      { _tag: "ReconnectTimeout" },
      { _tag: "Error", message: "fail" },
    ];
    for (const event of events) {
      const result = transitionSession({ _tag: "Expired" }, event);
      expect(result._tag).toBe("TransitionError");
    }
  });

  // Invalid transitions from Registering
  test("Registering rejects non-StartCreating/Error events", () => {
    const invalidEvents: SessionEvent[] = [
      { _tag: "ContainerCreated" },
      { _tag: "CdpConnected" },
      { _tag: "IdleTimeout" },
      { _tag: "CdpDisconnected" },
      { _tag: "SocketDisconnected" },
      { _tag: "SocketReconnected" },
      { _tag: "ReconnectTimeout" },
    ];
    for (const event of invalidEvents) {
      const result = transitionSession({ _tag: "Registering" }, event);
      expect(result._tag).toBe("TransitionError");
    }
  });

  // Invalid transitions from CreatingContainer
  test("CreatingContainer rejects non-ContainerCreated/Error events", () => {
    const invalidEvents: SessionEvent[] = [
      { _tag: "StartCreating" },
      { _tag: "CdpConnected" },
      { _tag: "IdleTimeout" },
      { _tag: "CdpDisconnected" },
      { _tag: "SocketDisconnected" },
      { _tag: "SocketReconnected" },
      { _tag: "ReconnectTimeout" },
    ];
    for (const event of invalidEvents) {
      const result = transitionSession({ _tag: "CreatingContainer" }, event);
      expect(result._tag).toBe("TransitionError");
    }
  });

  // Invalid transitions from ConnectingCDP
  test("ConnectingCDP rejects non-CdpConnected/Error events", () => {
    const invalidEvents: SessionEvent[] = [
      { _tag: "StartCreating" },
      { _tag: "ContainerCreated" },
      { _tag: "IdleTimeout" },
      { _tag: "CdpDisconnected" },
      { _tag: "SocketDisconnected" },
      { _tag: "SocketReconnected" },
      { _tag: "ReconnectTimeout" },
    ];
    for (const event of invalidEvents) {
      const result = transitionSession({ _tag: "ConnectingCDP" }, event);
      expect(result._tag).toBe("TransitionError");
    }
  });

  // Invalid transitions from Active
  test("Active rejects non-applicable events", () => {
    const invalidEvents: SessionEvent[] = [
      { _tag: "StartCreating" },
      { _tag: "ContainerCreated" },
      { _tag: "CdpConnected" },
      { _tag: "SocketReconnected" },
      { _tag: "ReconnectTimeout" },
    ];
    for (const event of invalidEvents) {
      const result = transitionSession({ _tag: "Active" }, event);
      expect(result._tag).toBe("TransitionError");
    }
  });

  // Invalid transitions from Reconnecting
  test("Reconnecting rejects non-applicable events", () => {
    const invalidEvents: SessionEvent[] = [
      { _tag: "StartCreating" },
      { _tag: "ContainerCreated" },
      { _tag: "CdpConnected" },
      { _tag: "IdleTimeout" },
      { _tag: "CdpDisconnected" },
      { _tag: "SocketDisconnected" },
    ];
    for (const event of invalidEvents) {
      const result = transitionSession({ _tag: "Reconnecting" }, event);
      expect(result._tag).toBe("TransitionError");
    }
  });

  // Full lifecycle simulation
  test("full lifecycle: register → active → disconnect → reconnect → idle expire", () => {
    let state: SessionState = { _tag: "Registering" };

    const step1 = transitionSession(state, { _tag: "StartCreating" });
    expect(step1._tag).toBe("CreatingContainer");
    state = step1 as SessionState;

    const step2 = transitionSession(state, { _tag: "ContainerCreated" });
    expect(step2._tag).toBe("ConnectingCDP");
    state = step2 as SessionState;

    const step3 = transitionSession(state, { _tag: "CdpConnected" });
    expect(step3._tag).toBe("Active");
    state = step3 as SessionState;

    const step4 = transitionSession(state, { _tag: "SocketDisconnected" });
    expect(step4._tag).toBe("Reconnecting");
    state = step4 as SessionState;

    const step5 = transitionSession(state, { _tag: "SocketReconnected" });
    expect(step5._tag).toBe("Active");
    state = step5 as SessionState;

    const step6 = transitionSession(state, { _tag: "IdleTimeout" });
    expect(step6._tag).toBe("Expired");
  });
});
