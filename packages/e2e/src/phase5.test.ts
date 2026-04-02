import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { io, type Socket } from "socket.io-client";
import { TEST_CONFIG } from "./helpers";
import { ensureEnvironment } from "./setup";

describe("Phase 5: profile management", () => {
  let socket: Socket | undefined;

  beforeAll(async () => {
    await ensureEnvironment();
    socket = io(TEST_CONFIG.controllerUrl, {
      autoConnect: false,
      timeout: 10000,
    });
    await new Promise<void>((resolve) => {
      socket!.on("connect", () => resolve());
      socket!.connect();
    });
  });

  afterAll(async () => {
    if (!socket) return;
    // Ensure profile is unfrozen for other tests
    await new Promise<unknown>((resolve) => {
      socket!.emit("unfreezeProfile", resolve);
    }).catch(() => {});
    socket.disconnect();
  });

  test("freezeProfile creates frozen marker", async () => {
    // Ensure unfrozen first
    await new Promise<unknown>((resolve) => {
      socket!.emit("unfreezeProfile", resolve);
    }).catch(() => {});

    const response = await new Promise<unknown>((resolve) => {
      socket!.emit("freezeProfile", resolve);
    });
    expect(response).toEqual({ ok: true });
  });

  test("profileStatus returns frozen: true after freeze", async () => {
    const response = await new Promise<unknown>((resolve) => {
      socket!.emit("profileStatus", resolve);
    });
    expect(response).toEqual({ frozen: true });
  });

  test("freezeProfile again returns error (already frozen)", async () => {
    const response = await new Promise<unknown>((resolve) => {
      socket!.emit("freezeProfile", resolve);
    });
    const error = response as { _tag: string };
    expect(error._tag).toBe("ProfileError");
  });

  test("unfreezeProfile removes frozen marker", async () => {
    const response = await new Promise<unknown>((resolve) => {
      socket!.emit("unfreezeProfile", resolve);
    });
    expect(response).toEqual({ ok: true });
  });

  test("profileStatus returns frozen: false after unfreeze", async () => {
    const response = await new Promise<unknown>((resolve) => {
      socket!.emit("profileStatus", resolve);
    });
    expect(response).toEqual({ frozen: false });
  });

  test("unfreezeProfile again returns error (not frozen)", async () => {
    const response = await new Promise<unknown>((resolve) => {
      socket!.emit("unfreezeProfile", resolve);
    });
    const error = response as { _tag: string };
    expect(error._tag).toBe("ProfileError");
  });
});
