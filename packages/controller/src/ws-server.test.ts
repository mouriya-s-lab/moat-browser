import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Browser, BrowserContext } from "patchright";
import type { WireRequest, WireResponse } from "@moat-browser/types";
import { createSessionRegistry, type SessionRegistry } from "./session-registry";
import { createWsHandler } from "./ws-server.js";
import { createRefStore } from "./ref-store.js";
import type { ContainerManager } from "./container-manager.js";
import { createSessionAdmission } from "./session-admission.js";
import { profileDestination } from "./container-manager.js";
import type { CdpConnection } from "./cdp-bridge.js";
import type { ControllerConfig } from "./index.js";
import type { WebSocket } from "ws";

type MessageHandler = (raw: string) => Promise<void> | void;
type DisconnectHandler = () => Promise<void> | void;

type SentResponse = WireResponse | { readonly type: "error"; readonly error: string; readonly code: number };

type FakeSocket = {
  readonly socket: WebSocket;
  readonly sent: SentResponse[];
  sendMessage(request: WireRequest | string): Promise<void>;
};

type FakeBrowser = {
  readonly browser: Browser;
  closeCount(): number;
  disconnect(): Promise<void>;
};

const config: ControllerConfig = {
  port: 3000,
  profileSource: "/tmp",
  profileRegistry: { secondary: "/tmp" },
  profileStoreRoot: "/tmp",
  profilesWork: "/data/profiles",
  profilesHostPath: "/data/profiles",
  dockerNetwork: "moat",
  agentChromeImage: "agent-chrome:latest",
  sessionIdleTimeout: 600_000,
  cdpReadyTimeout: 30_000,
  commandTimeout: 25_000,
  controllerOwner: "test-owner",
};

let originalLog: typeof console.log;
let originalWarn: typeof console.warn;
let logs: string[];
let warns: string[];
let registry: SessionRegistry | undefined;

beforeEach(() => {
  logs = [];
  warns = [];
  originalLog = console.log;
  originalWarn = console.warn;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  registry?.dispose();
  registry = undefined;
});

function ok<T>(value: T) {
  return { _tag: "Ok", value } as const;
}

function createFakeSocket(): FakeSocket {
  let messageHandler: MessageHandler | undefined;
  const sent: SentResponse[] = [];

  const socket = {
    on(event: string, handler: MessageHandler): void {
      if (event === "message") {
        messageHandler = handler;
      }
    },
    send(payload: string): void {
      sent.push(JSON.parse(payload) as SentResponse);
    },
  } as unknown as WebSocket;

  return {
    socket,
    sent,
    async sendMessage(request) {
      if (!messageHandler) {
        throw new Error("message handler not registered");
      }
      await messageHandler(typeof request === "string" ? request : JSON.stringify(request));
    },
  };
}

function createFakeBrowser(): FakeBrowser {
  const disconnectHandlers: DisconnectHandler[] = [];
  let closed = 0;

  const browser = {
    on(event: string, handler: DisconnectHandler): void {
      if (event === "disconnected") {
        disconnectHandlers.push(handler);
      }
    },
    async close(): Promise<void> {
      closed += 1;
    },
  } as unknown as Browser;

  return {
    browser,
    closeCount() {
      return closed;
    },
    async disconnect() {
      for (const handler of disconnectHandlers) {
        await handler();
      }
    },
  };
}

type DestroyOutcome =
  | { readonly _tag: "Ok"; readonly value: undefined }
  | { readonly _tag: "Err"; readonly error:
      | { readonly _tag: "ContainerCreateFailed"; readonly message: string }
      | { readonly _tag: "ProfileCleanupFailed"; readonly sessionId: string; readonly path: string; readonly message: string }
    };

function createContainerManager(
  destroyed: string[],
  destroyResult: (sessionId: string) => DestroyOutcome = () => ok(undefined) as DestroyOutcome,
): ContainerManager {
  return {
    async create(_sessionId, _profilePath) {
      return ok({ containerId: "ctr-1", ip: "127.0.0.1", cdpPort: 9222 });
    },
    async destroy(sessionId) {
      destroyed.push(sessionId);
      return destroyResult(sessionId);
    },
    async inspect(containerId) {
      return ok({ containerId, ip: "127.0.0.1", cdpPort: 9222 });
    },
    async reap() {
      return ok({ reaped: 0 });
    },
  };
}

function expectSessionLog(kind: string, sessionId: string, suffix = ""): void {
  const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T.* \\[${kind}\\] session=${sessionId}${suffix}$`);
  expect(logs.some((line) => pattern.test(line))).toBe(true);
}

describe("ws-server activity logging", () => {
  it("logs register, command, deregister, and cdp disconnect events", async () => {
    registry = createSessionRegistry();
    const destroyed: string[] = [];
    const fakeBrowser = createFakeBrowser();
    const fakeSocket = createFakeSocket();
    const cdp: CdpConnection = {
      browser: fakeBrowser.browser,
      context: {} as BrowserContext,
    };

    const handler = createWsHandler({
      registry,
      containerManager: createContainerManager(destroyed),
      refStore: createRefStore(),
      config,
      async connectCDP() {
        return cdp;
      },
      async executeCommand() {
        return ok({ _tag: "VoidResult" } as const);
      },
    });

    handler.handleConnection(fakeSocket.socket);

    await fakeSocket.sendMessage({ type: "register" });
    const registerResponse = fakeSocket.sent[0];
    expect(registerResponse.type).toBe("register_result");
    if (registerResponse.type !== "register_result" || !registerResponse.success) {
      throw new Error("expected successful register response");
    }
    const sessionId = registerResponse.sessionId;
    expectSessionLog("register", sessionId, " profile=default");

    await fakeSocket.sendMessage({ type: "command", sessionId, command: { action: "reload" } });
    expectSessionLog("command", sessionId, " action=reload");

    await fakeBrowser.disconnect();
    expectSessionLog("cdp-disconnect", sessionId);
    expect(destroyed).toContain(sessionId);

    await fakeSocket.sendMessage({ type: "register", profile: "secondary" });
    const secondRegisterResponse = fakeSocket.sent[2];
    expect(secondRegisterResponse.type).toBe("register_result");
    if (secondRegisterResponse.type !== "register_result" || !secondRegisterResponse.success) {
      throw new Error("expected successful second register response");
    }
    const secondSessionId = secondRegisterResponse.sessionId;
    await fakeSocket.sendMessage({ type: "deregister", sessionId: secondSessionId });
    expectSessionLog("register", secondSessionId, " profile=secondary");
    expectSessionLog("deregister", secondSessionId);
    expect(fakeBrowser.closeCount()).toBe(1);
  });

  it("logs explicit session expiration with the supplied reason", () => {
    registry = createSessionRegistry();
    const handler = createWsHandler({
      registry,
      containerManager: createContainerManager([]),
      refStore: createRefStore(),
      config,
    });

    handler.onSessionExpired("session-1", "idle timeout");

    expectSessionLog("expired", "session-1", " reason=idle timeout");
  });

  it("warns when idle-expired destroy fails so orphan reasons are observable", async () => {
    registry = createSessionRegistry();
    const handler = createWsHandler({
      registry,
      containerManager: createContainerManager([], (sid) => ({
        _tag: "Err",
        error: { _tag: "ContainerCreateFailed", message: `No container for session ${sid}` },
      })),
      refStore: createRefStore(),
      config,
    });

    handler.onSessionExpired("session-orphan", "idle timeout");

    // let the fire-and-forget destroy chain settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    const hit = warns.find(
      (line) =>
        line.includes("[destroy-failed]") &&
        line.includes("session=session-orphan") &&
        line.includes("trigger=idle-expired") &&
        line.includes("No container for session session-orphan"),
    );
    expect(hit).toBeDefined();
  });

  it("keeps admission occupied when container removal succeeds but profile cleanup fails, then releases after retry", async () => {
    registry = createSessionRegistry();
    const admission = createSessionAdmission({
      owner: config.controllerOwner,
      ownerQuota: 1,
      totalQuota: 1,
      pendingReservationGraceMs: config.cdpReadyTimeout * 2,
    });
    let releaseCalls = 0;
    let resolveReleased!: () => void;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const fakeSocket = createFakeSocket();
    const browser = createFakeBrowser();
    const destroyed: string[] = [];
    const handler = createWsHandler({
      registry,
      admission: {
        ...admission,
        async release(sessionId) {
          releaseCalls += 1;
          const result = await admission.release(sessionId);
          resolveReleased();
          return result;
        },
      },
      containerManager: createContainerManager(destroyed, (sessionId) =>
        destroyed.length === 1
          ? {
              _tag: "Err",
              error: {
                _tag: "ProfileCleanupFailed",
                sessionId,
                path: profileDestination(config.profilesWork, config.controllerOwner, sessionId),
                message: "permission denied",
              },
            }
          : ok(undefined),
      ),
      refStore: createRefStore(),
      config,
      async connectCDP() {
        return { browser: browser.browser, context: {} as BrowserContext };
      },
    });
    handler.handleConnection(fakeSocket.socket);
    await fakeSocket.sendMessage({ type: "register" });
    const registered = fakeSocket.sent[0];
    if (registered.type !== "register_result" || !registered.success) throw new Error("registration failed");
    const sessionId = registered.sessionId;
    const beforeCleanup = await admission.snapshot();
    expect(beforeCleanup._tag).toBe("Ok");
    if (beforeCleanup._tag !== "Ok") throw new Error("admission snapshot failed");
    expect(beforeCleanup.value.current).toBe(1);
    expect(beforeCleanup.value.ownerCurrent).toBe(1);

    await fakeSocket.sendMessage({ type: "deregister", sessionId });
    const response = fakeSocket.sent[1];
    if (response.type !== "deregister_result" || response.success) throw new Error("expected cleanup failure");
    expect(response.errorType).toBe("command_failed");
    if (response.errorType !== "command_failed") throw new Error("expected command failure");
    expect(response.cause).toBe("cleanup");
    expect(response.error).toContain("permission denied");
    expect(destroyed).toEqual([sessionId]);
    const afterFailure = await admission.snapshot();
    expect(afterFailure._tag).toBe("Ok");
    if (afterFailure._tag !== "Ok") throw new Error("admission snapshot failed");
    expect(afterFailure.value.current).toBe(1);
    expect(afterFailure.value.ownerCurrent).toBe(1);
    expect(releaseCalls).toBe(0);

    handler.onSessionExpired(sessionId, "cleanup retry");
    await released;
    const afterRetry = await admission.snapshot();
    expect(afterRetry._tag).toBe("Ok");
    if (afterRetry._tag !== "Ok") throw new Error("admission snapshot failed");
    expect(afterRetry.value.current).toBe(0);
    expect(afterRetry.value.ownerCurrent).toBe(0);
    expect(destroyed).toEqual([sessionId, sessionId]);
    expect(releaseCalls).toBe(1);
  });

  it("does not emit activity logs for invalid requests", async () => {
    registry = createSessionRegistry();
    const fakeSocket = createFakeSocket();
    const handler = createWsHandler({
      registry,
      containerManager: createContainerManager([]),
      refStore: createRefStore(),
      config,
    });

    handler.handleConnection(fakeSocket.socket);

    await fakeSocket.sendMessage("not-json");

    expect(fakeSocket.sent).toEqual([{ type: "error", error: "Invalid request", code: 2 }]);
    expect(logs).toEqual([]);
  });
});
