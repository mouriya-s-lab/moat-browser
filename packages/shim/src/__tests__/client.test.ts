import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Server } from "socket.io";
import { connect, BrowserClient } from "../index";

// Mock Socket.IO server that simulates the controller
function createMockServer(port: number): Server {
  const io = new Server(port, { cors: { origin: "*" } });

  io.on("connection", (socket) => {
    socket.on("register", (token: unknown, callback?: (res: unknown) => void) => {
      if (token === "bad-token") {
        const error = { _tag: "AuthError", message: "Invalid token signature" };
        if (callback) return callback(error);
        return;
      }
      const response = { sessionId: "test-session-123" };
      if (callback) return callback(response);
    });

    socket.on("command", (data: unknown, callback?: (res: unknown) => void) => {
      const cmd = data as { _tag: string; [key: string]: unknown };

      switch (cmd._tag) {
        case "Navigate": {
          if (callback) return callback({
            _tag: "NavigateResult",
            url: cmd.url as string,
            title: "Example Domain",
          });
          break;
        }
        case "Click": {
          if (cmd.selector === "nonexistent") {
            if (callback) return callback({
              _tag: "CommandError",
              command: "Click",
              message: "Element not found: nonexistent",
            });
            return;
          }
          if (callback) return callback({ _tag: "ClickResult" });
          break;
        }
        case "Fill": {
          if (callback) return callback({ _tag: "FillResult" });
          break;
        }
        case "Snapshot": {
          if (callback) return callback({
            _tag: "SnapshotResult",
            aria: "- heading: Example Domain\n- paragraph: This domain is for use...",
          });
          break;
        }
        case "Screenshot": {
          if (callback) return callback({
            _tag: "ScreenshotResult",
            png: "iVBORw0KGgoAAAANSUhEUg==",
          });
          break;
        }
        case "Evaluate": {
          if (callback) return callback({
            _tag: "EvaluateResult",
            value: 42,
          });
          break;
        }
        case "NewTab":
        case "SwitchTab":
        case "CloseTab": {
          if (callback) return callback({
            _tag: "TabResult",
            tabs: [{ index: 0, url: "about:blank", title: "" }],
          });
          break;
        }
        case "Wait": {
          if (callback) return callback({ _tag: "WaitResult" });
          break;
        }
        default: {
          if (callback) return callback({
            _tag: "ValidationError",
            message: `Unknown command: ${cmd._tag}`,
          });
        }
      }
    });

    socket.on("deregister", (callback?: (res: unknown) => void) => {
      if (callback) return callback({ ok: true });
    });
  });

  return io;
}

const TEST_PORT = 13579;
const TEST_URL = `http://localhost:${TEST_PORT}`;
let server: Server;

beforeAll(() => {
  server = createMockServer(TEST_PORT);
});

afterAll(() => {
  server.close();
});

describe("connect", () => {
  test("returns BrowserClient on successful registration", async () => {
    const result = await connect(TEST_URL, "valid-token");
    expect("_tag" in result).toBe(false);
    const client = result as BrowserClient;
    expect(client.sessionId).toBe("test-session-123");
    await client.disconnect();
  });

  test("returns AuthError on invalid token", async () => {
    const result = await connect(TEST_URL, "bad-token");
    expect("_tag" in result).toBe(true);
    const error = result as { _tag: string; message: string };
    expect(error._tag).toBe("AuthError");
    expect(error.message).toBe("Invalid token signature");
  });

  test("returns ContainerError on connection failure", async () => {
    const result = await connect("http://localhost:19999", "any-token");
    expect("_tag" in result).toBe(true);
    const error = result as { _tag: string; message: string };
    expect(error._tag).toBe("ContainerError");
  });
});

describe("BrowserClient commands", () => {
  let client: BrowserClient;

  beforeAll(async () => {
    const result = await connect(TEST_URL, "valid-token");
    if ("_tag" in result) throw new Error(`connect failed: ${JSON.stringify(result)}`);
    client = result;
  });

  afterAll(async () => {
    await client.disconnect();
  });

  test("navigate returns NavigateResult", async () => {
    const result = await client.navigate("http://example.com");
    expect(result._tag).toBe("NavigateResult");
    if (result._tag !== "NavigateResult") return;
    expect(result.url).toBe("http://example.com");
    expect(result.title).toBe("Example Domain");
  });

  test("click returns ClickResult", async () => {
    const result = await client.click("button");
    expect(result._tag).toBe("ClickResult");
  });

  test("fill returns FillResult", async () => {
    const result = await client.fill("input", "hello");
    expect(result._tag).toBe("FillResult");
  });

  test("snapshot returns SnapshotResult", async () => {
    const result = await client.snapshot();
    expect(result._tag).toBe("SnapshotResult");
    if (result._tag !== "SnapshotResult") return;
    expect(result.aria.length).toBeGreaterThan(0);
  });

  test("screenshot returns ScreenshotResult", async () => {
    const result = await client.screenshot();
    expect(result._tag).toBe("ScreenshotResult");
    if (result._tag !== "ScreenshotResult") return;
    expect(result.png.length).toBeGreaterThan(0);
  });

  test("evaluate returns EvaluateResult", async () => {
    const result = await client.evaluate("1 + 1");
    expect(result._tag).toBe("EvaluateResult");
    if (result._tag !== "EvaluateResult") return;
    expect(result.value).toBe(42);
  });

  test("newTab returns TabResult", async () => {
    const result = await client.newTab();
    expect(result._tag).toBe("TabResult");
    if (result._tag !== "TabResult") return;
    expect(result.tabs.length).toBeGreaterThan(0);
  });

  test("switchTab returns TabResult", async () => {
    const result = await client.switchTab(0);
    expect(result._tag).toBe("TabResult");
  });

  test("closeTab returns TabResult", async () => {
    const result = await client.closeTab(0);
    expect(result._tag).toBe("TabResult");
  });

  test("wait returns WaitResult", async () => {
    const result = await client.wait("div");
    expect(result._tag).toBe("WaitResult");
  });

  test("click nonexistent selector returns CommandError", async () => {
    const result = await client.click("nonexistent");
    expect(result._tag).toBe("CommandError");
    if (result._tag !== "CommandError") return;
    expect(result.command).toBe("Click");
    expect(result.message).toContain("nonexistent");
  });
});
