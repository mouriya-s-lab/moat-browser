import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { io, type Socket } from "socket.io-client";
import { TEST_CONFIG, createTestToken } from "./helpers";
import { ensureEnvironment } from "./setup";

describe("Phase 4: controller", () => {
  let socket: Socket;

  beforeAll(async () => {
    await ensureEnvironment();
  });

  afterAll(() => {
    if (socket?.connected) socket.disconnect();
  });

  test("Socket.IO connection succeeds", async () => {
    socket = io(TEST_CONFIG.controllerUrl, {
      autoConnect: false,
      timeout: 10000,
    });

    const connected = await new Promise<boolean>((resolve) => {
      socket.on("connect", () => resolve(true));
      socket.on("connect_error", () => resolve(false));
      socket.connect();
    });
    expect(connected).toBe(true);
  });

  test("register with valid token returns sessionId", async () => {
    const token = createTestToken("e2e-agent-phase4");
    const response = await new Promise<unknown>((resolve) => {
      socket.emit("register", token, resolve);
    });
    expect(response).toHaveProperty("sessionId");
    expect(typeof (response as { sessionId: string }).sessionId).toBe(
      "string"
    );
  }, 60000);

  test("command execution works (Navigate)", async () => {
    const command = { _tag: "Navigate", url: TEST_CONFIG.webappUrl };
    const response = await new Promise<unknown>((resolve) => {
      socket.emit("command", command, resolve);
    });
    const result = response as { _tag: string; url: string; title: string };
    expect(result._tag).toBe("NavigateResult");
    expect(result.title).toBe("Moat Test Page");
  }, 30000);

  test("register with invalid token returns AuthError", async () => {
    const otherSocket = io(TEST_CONFIG.controllerUrl, {
      autoConnect: false,
      timeout: 10000,
    });
    await new Promise<void>((resolve) => {
      otherSocket.on("connect", () => resolve());
      otherSocket.connect();
    });

    const response = await new Promise<unknown>((resolve) => {
      otherSocket.emit("register", "invalid-token", resolve);
    });
    const error = response as { _tag: string };
    expect(error._tag).toBe("AuthError");
    otherSocket.disconnect();
  });

  test("deregister succeeds", async () => {
    const response = await new Promise<unknown>((resolve) => {
      socket.emit("deregister", resolve);
    });
    expect(response).toEqual({ ok: true });
  }, 30000);
});
