import { describe, expect, it } from "bun:test";
import { transitionSession } from "@moat-browser/types";
import type { SessionState, SessionEvent } from "@moat-browser/types";

function ok(state: SessionState, event: SessionEvent): SessionState {
  const result = transitionSession(state, event);
  if (result._tag !== "Ok") {
    throw new Error(`Expected Ok but got InvalidTransition: ${result.from} + ${result.event}`);
  }
  return result.state;
}

function invalid(state: SessionState, event: SessionEvent): void {
  const result = transitionSession(state, event);
  expect(result._tag).toBe("InvalidTransition");
}

describe("Session State Machine", () => {
  describe("happy path: Register → Active → Deregister", () => {
    it("transitions through full lifecycle", () => {
      let state: SessionState = { _tag: "Registering" };

      state = ok(state, { _tag: "Register" });
      expect(state._tag).toBe("CreatingContainer");

      state = ok(state, { _tag: "ContainerCreated" });
      expect(state._tag).toBe("ConnectingCDP");

      state = ok(state, { _tag: "CDPConnected" });
      expect(state._tag).toBe("Active");

      state = ok(state, { _tag: "Deregister" });
      expect(state._tag).toBe("Expired");
    });
  });

  describe("Active → disconnect → reconnect", () => {
    it("transitions through reconnect path", () => {
      let state: SessionState = { _tag: "Active" };

      state = ok(state, { _tag: "SocketDisconnected" });
      expect(state._tag).toBe("Reconnecting");

      state = ok(state, { _tag: "SocketReconnected" });
      expect(state._tag).toBe("Active");
    });
  });

  describe("Active → disconnect → timeout → expired", () => {
    it("expires on reconnect timeout", () => {
      let state: SessionState = { _tag: "Active" };

      state = ok(state, { _tag: "SocketDisconnected" });
      expect(state._tag).toBe("Reconnecting");

      state = ok(state, { _tag: "ReconnectTimeout" });
      expect(state._tag).toBe("Expired");
    });
  });

  describe("Active → CDP disconnect → expired", () => {
    it("expires on CDP disconnect", () => {
      let state: SessionState = { _tag: "Active" };

      state = ok(state, { _tag: "CDPDisconnected" });
      expect(state._tag).toBe("Expired");
    });
  });

  describe("Active → idle timeout → expired", () => {
    it("expires on idle timeout", () => {
      let state: SessionState = { _tag: "Active" };

      state = ok(state, { _tag: "IdleTimeout" });
      expect(state._tag).toBe("Expired");
    });
  });

  describe("Reconnecting → CDP disconnect → expired", () => {
    it("expires if CDP drops during reconnect", () => {
      let state: SessionState = { _tag: "Reconnecting" };

      state = ok(state, { _tag: "CDPDisconnected" });
      expect(state._tag).toBe("Expired");
    });
  });

  describe("Deregister from any non-Expired state", () => {
    const statesAllowingDeregister: ReadonlyArray<SessionState> = [
      { _tag: "Registering" },
      { _tag: "CreatingContainer" },
      { _tag: "ConnectingCDP" },
      { _tag: "Active" },
      { _tag: "Reconnecting" },
    ];

    for (const state of statesAllowingDeregister) {
      it(`Deregister from ${state._tag} → Expired`, () => {
        const result = ok(state, { _tag: "Deregister" });
        expect(result._tag).toBe("Expired");
      });
    }
  });

  describe("Expired is terminal", () => {
    const allEvents: ReadonlyArray<SessionEvent> = [
      { _tag: "Register" },
      { _tag: "ContainerCreated" },
      { _tag: "CDPConnected" },
      { _tag: "SocketDisconnected" },
      { _tag: "SocketReconnected" },
      { _tag: "CDPDisconnected" },
      { _tag: "IdleTimeout" },
      { _tag: "ReconnectTimeout" },
      { _tag: "Deregister" },
    ];

    for (const event of allEvents) {
      it(`rejects ${event._tag} from Expired`, () => {
        invalid({ _tag: "Expired" }, event);
      });
    }
  });

  describe("invalid transitions", () => {
    it("rejects ContainerCreated from Registering", () => {
      invalid({ _tag: "Registering" }, { _tag: "ContainerCreated" });
    });

    it("rejects CDPConnected from CreatingContainer", () => {
      invalid({ _tag: "CreatingContainer" }, { _tag: "CDPConnected" });
    });

    it("rejects Register from Active", () => {
      invalid({ _tag: "Active" }, { _tag: "Register" });
    });

    it("rejects SocketReconnected from Active", () => {
      invalid({ _tag: "Active" }, { _tag: "SocketReconnected" });
    });

    it("rejects Register from Reconnecting", () => {
      invalid({ _tag: "Reconnecting" }, { _tag: "Register" });
    });
  });
});
