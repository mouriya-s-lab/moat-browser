import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  createSessionRegistry,
  type SessionRegistry,
} from "./session-registry";

let registry: SessionRegistry;

function makeActive(sessionId: string): void {
  const now = Date.now();
  registry.transition(sessionId, {
    _tag: "Active",
    containerId: "ctr-1",
    containerIp: "172.17.0.2",
    cdpUrl: "ws://172.17.0.2:9222",
    createdAt: now,
    lastActivity: now,
  });
}

describe("register", () => {
  beforeEach(() => {
    registry = createSessionRegistry();
  });
  afterEach(() => {
    registry.dispose();
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
  afterEach(() => {
    registry.dispose();
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
    registry = createSessionRegistry(
      { sessionIdleTimeout: 50, scanInterval: 20 },
      (id, reason) => {
        expiredId = id;
        expiredReason = reason;
      },
    );

    const reg = registry.register();
    if (reg._tag !== "Ok") throw new Error("expected Ok");
    const sid = reg.value;

    // Transition to Active with lastActivity = now
    makeActive(sid);

    // Wait for idle timeout + scan interval
    await new Promise((r) => setTimeout(r, 120));

    const state = registry.get(sid);
    expect(state?._tag).toBe("Expired");
    if (state?._tag === "Expired") {
      expect(state.reason).toBe("idle timeout");
    }
    expect(expiredId).toBe(sid);
    expect(expiredReason).toBe("idle timeout");

    registry.dispose();
  });

  it("touchActivity resets idle timer", async () => {
    registry = createSessionRegistry(
      { sessionIdleTimeout: 80, scanInterval: 20 },
    );

    const reg = registry.register();
    if (reg._tag !== "Ok") throw new Error("expected Ok");
    const sid = reg.value;
    makeActive(sid);

    // Touch at 40ms — still within timeout
    await new Promise((r) => setTimeout(r, 40));
    registry.touchActivity(sid);

    // Wait another 60ms — total 100ms from register, but only 60ms from touch
    await new Promise((r) => setTimeout(r, 60));

    const state = registry.get(sid);
    expect(state?._tag).toBe("Active");

    registry.dispose();
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
    registry.dispose();
  });

  it("deregister on nonexistent returns SessionNotFound", () => {
    registry = createSessionRegistry();
    const result = registry.deregister("no-such-id");
    expect(result._tag).toBe("Err");
    if (result._tag === "Err") {
      expect(result.error._tag).toBe("SessionNotFound");
    }
    registry.dispose();
  });
});
