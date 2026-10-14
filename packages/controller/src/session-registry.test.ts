import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import {
  createSessionRegistry,
  type SessionRegistry,
} from "./session-registry";

let registry: SessionRegistry;

afterEach(() => registry?.dispose());

function makeActive(sessionId: string): void {
  const now = Date.now();
  registry.transition(sessionId, {
    _tag: "Active",
    containerId: "ctr-1",
    containerIp: "agent-chrome.test",
    cdpUrl: "ws://agent-chrome.test:9222",
    createdAt: now,
    lastActivity: now,
  });
}

describe("register", () => {
  beforeEach(() => {
    registry = createSessionRegistry();
  });

  it("returns Ok with a UUID sessionId", () => {
    const result = registry.register();
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") {
      expect(result.value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it("register sets initial state to Registering", () => {
    const result = registry.register("my-profile");
    if (result._tag !== "Ok") throw new Error("expected Ok");
    const state = registry.get(result.value);
    expect(state).toEqual({ _tag: "Registering" });
  });

  it("each register returns a different sessionId", () => {
    const r1 = registry.register();
    const r2 = registry.register();
    if (r1._tag !== "Ok" || r2._tag !== "Ok") throw new Error("expected Ok");
    expect(r1.value).not.toBe(r2.value);
  });
});

describe("getActive", () => {
  beforeEach(() => {
    registry = createSessionRegistry();
  });

  it("returns SessionNotFound for unknown sessionId", () => {
    const result = registry.getActive("nonexistent");
    expect(result._tag).toBe("Err");
    if (result._tag === "Err") {
      expect(result.error._tag).toBe("SessionNotFound");
    }
  });

  it("returns SessionNotReady for Registering state", () => {
    const reg = registry.register();
    if (reg._tag !== "Ok") throw new Error("expected Ok");
    const result = registry.getActive(reg.value);
    expect(result._tag).toBe("Err");
    if (result._tag === "Err") {
      expect(result.error._tag).toBe("SessionNotReady");
    }
  });

  it("returns SessionExpired for Expired state", () => {
    const reg = registry.register();
    if (reg._tag !== "Ok") throw new Error("expected Ok");
    registry.transition(reg.value, { _tag: "Expired", reason: "test" });
    const result = registry.getActive(reg.value);
    expect(result._tag).toBe("Err");
    if (result._tag === "Err") {
      expect(result.error._tag).toBe("SessionExpired");
    }
  });

  it("returns Ok with ActiveSession for Active state", () => {
    const reg = registry.register();
    if (reg._tag !== "Ok") throw new Error("expected Ok");
    makeActive(reg.value);
    const result = registry.getActive(reg.value);
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") {
      expect(result.value._tag).toBe("Active");
      expect(result.value.containerId).toBe("ctr-1");
    }
  });
});

describe("idle timeout", () => {
  it("expires session after idle timeout", async () => {
    let expiredId: string | undefined;
    let expiredReason: string | undefined;
    const expired = new Promise<void>((resolve) => {
      registry = createSessionRegistry(
        { sessionIdleTimeout: 50, scanInterval: 20 },
        (id, reason) => {
          expiredId = id;
          expiredReason = reason;
          resolve();
        },
      );
    });

    const reg = registry.register();
    if (reg._tag !== "Ok") throw new Error("expected Ok");
    const sid = reg.value;

    // Transition to Active with lastActivity = now
    makeActive(sid);

    await expired;

    const state = registry.get(sid);
    expect(state?._tag).toBe("Expired");
    if (state?._tag === "Expired") {
      expect(state.reason).toBe("idle timeout");
    }
    expect(expiredId).toBe(sid);
    expect(expiredReason).toBe("idle timeout");
  });

  it("touchActivity prevents expiry at the old deadline and expires at the new one", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const expired = new Promise<void>((resolve) => {
        registry = createSessionRegistry({ sessionIdleTimeout: 80, scanInterval: 1 }, () => resolve());
      });
      const registered = registry.register();
      if (registered._tag !== "Ok") throw new Error("registration failed");
      const sid = registered.value;
      makeActive(sid);
      now = 60;
      registry.touchActivity(sid);
      now = 100;
      // The clock stays fixed while the real scanner runs, so scheduler delays
      // cannot push this check past the session's new expiry deadline.
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(registry.get(sid)?._tag).toBe("Active");
      now = 160;
      await expired;
      expect(registry.get(sid)).toEqual({ _tag: "Expired", reason: "idle timeout" });
    } finally {
      clock.mockRestore();
    }
  });
});

describe("deregister", () => {
  it("deregister transitions session to Expired", () => {
    let expiredReason: string | undefined;
    registry = createSessionRegistry({}, (_id, reason) => {
      expiredReason = reason;
    });

    const reg = registry.register();
    if (reg._tag !== "Ok") throw new Error("expected Ok");
    makeActive(reg.value);

    const result = registry.deregister(reg.value);
    expect(result._tag).toBe("Ok");

    const state = registry.get(reg.value);
    expect(state?._tag).toBe("Expired");
    if (state?._tag === "Expired") {
      expect(state.reason).toBe("deregistered");
    }
    expect(expiredReason).toBe("deregistered");
  });

  it("deregister on nonexistent returns SessionNotFound", () => {
    registry = createSessionRegistry();
    const result = registry.deregister("no-such-id");
    expect(result._tag).toBe("Err");
    if (result._tag === "Err") {
      expect(result.error._tag).toBe("SessionNotFound");
    }
  });
});
