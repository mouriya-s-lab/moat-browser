import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Browser, BrowserContext } from "patchright";
import type { WireRequest, WireResponse } from "@moat-browser/types";
import { createSessionRegistry, type SessionRegistry } from "./session-registry";
import { createWsHandler } from "./ws-server.js";
import { createRefStore } from "./ref-store.js";
import type { ContainerManager } from "./container-manager.js";
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
  profileSource: "/data/profile",
  profilesWork: "/data/profiles",
  profilesHostPath: "/data/profiles",
  dockerNetwork: "moat",
  agentChromeImage: "agent-chrome:latest",
  sessionIdleTimeout: 600_000,
  cdpReadyTimeout: 30_000,
  commandTimeout: 25_000,
};

let originalLog: typeof console.log;
let logs: string[];
let registry: SessionRegistry | undefined;

beforeEach(() => {
  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
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

function createContainerManager(destroyed: string[]): ContainerManager {
  return {
    async create(_sessionId, _profilePath) {
      return ok({ containerId: "ctr-1", ip: "127.0.0.1", cdpPort: 9222 });
    },
    async destroy(sessionId) {
      destroyed.push(sessionId);
      return ok(undefined);
    },
    async inspect(containerId) {
      return ok({ containerId, ip: "127.0.0.1", cdpPort: 9222 });
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
