import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";

// ─── Helpers ───

const CONTROLLER_URL = process.env.CONTROLLER_URL ?? "ws://localhost:3000";
const COMPOSE_FILE = new URL("./docker-compose.test.yml", import.meta.url).pathname;
const WS_READY_TIMEOUT = 60_000;
const MSG_TIMEOUT = 120_000;

type WireResponse = {
  type: string;
  success?: boolean;
  sessionId?: string;
  data?: { _tag: string; [k: string]: unknown };
  error?: string;
  code?: number;
};

function sendAndReceive(ws: WebSocket, msg: object): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Response timeout")), MSG_TIMEOUT);
    const handler = (event: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(JSON.parse(String(event.data)) as WireResponse);
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify(msg));
  });
}

function waitForWs(url: string, timeout: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    function attempt() {
      if (Date.now() > deadline) {
        reject(new Error(`WebSocket not ready after ${timeout}ms`));
        return;
      }
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(ws));
      ws.addEventListener("error", () => {
        setTimeout(attempt, 1000);
      });
    }
    attempt();
  });
}

function sessionContainerId(sessionId: string): string {
  const controllerId = execSync(`docker compose -f ${COMPOSE_FILE} ps -q controller`).toString().trim();
  const owner = execSync(`docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' ${controllerId}`)
    .toString().trim();
  return execSync(
    `docker ps --filter label=moat-browser.role=agent-chrome --filter label=moat-browser.owner=${owner} --filter label=moat-browser.session-id=${sessionId} --format '{{.ID}}'`,
  ).toString().trim();
}

// ─── Tests ───

describe("E2E: register → navigate → snapshot → deregister", () => {
  let ws: WebSocket;
  let sessionId: string;

  beforeAll(async () => {
    ws = await waitForWs(CONTROLLER_URL, WS_READY_TIMEOUT);
  }, WS_READY_TIMEOUT + 5_000);

  afterAll(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  test("register returns sessionId", async () => {
    const res = await sendAndReceive(ws, { type: "register" });
    expect(res.type).toBe("register_result");
    expect(res.success).toBe(true);
    expect(res.sessionId).toBeDefined();
    expect(typeof res.sessionId).toBe("string");
    sessionId = res.sessionId!;
  }, MSG_TIMEOUT + 5_000);

  test("agent-chrome container exists after register", () => {
    const out = sessionContainerId(sessionId);
    expect(out.length).toBeGreaterThan(0);
  });

  test("agent-chrome CDP is reachable", async () => {
    // Find agent-chrome container IP on moat network
    const containerId = sessionContainerId(sessionId);
    const ip = execSync(
      `docker inspect ${containerId} --format '{{(index .NetworkSettings.Networks "moat").IPAddress}}'`,
    ).toString().trim();
    const res = await fetch(`http://${ip}:9222/json/version`);
    expect(res.status).toBe(200);
  });

  test("navigate to example.com returns NavigateResult", async () => {
    const res = await sendAndReceive(ws, {
      type: "command",
      sessionId,
      command: { action: "navigate", url: "https://example.com" },
    });
    expect(res.type).toBe("command_result");
    expect(res.success).toBe(true);
    expect(res.data?._tag).toBe("NavigateResult");
  }, MSG_TIMEOUT + 5_000);

  test("snapshot returns SnapshotResult", async () => {
    const res = await sendAndReceive(ws, {
      type: "command",
      sessionId,
      command: { action: "snapshot" },
    });
    expect(res.type).toBe("command_result");
    expect(res.success).toBe(true);
    expect(res.data?._tag).toBe("SnapshotResult");
  }, MSG_TIMEOUT + 5_000);

  test("profiles-work has agent-<sessionId> directory", () => {
    // Check inside the controller container
    const out = execSync(
      `docker compose -f ${COMPOSE_FILE} exec controller ls /data/profiles/`,
    ).toString().trim();
    expect(out).toContain(`agent-${sessionId}`);
  });

  test("deregister returns success", async () => {
    const res = await sendAndReceive(ws, {
      type: "deregister",
      sessionId,
    });
    expect(res.type).toBe("deregister_result");
    expect(res.success).toBe(true);
    expect(res.sessionId).toBe(sessionId);
  }, MSG_TIMEOUT + 5_000);

  test("agent-chrome container cleaned up after deregister", async () => {
    // Give a moment for cleanup
    await new Promise((r) => setTimeout(r, 2000));
    const out = sessionContainerId(sessionId);
    expect(out).toBe("");
  });

  test("profile copy cleaned up after deregister", () => {
    const out = execSync(
      `docker compose -f ${COMPOSE_FILE} exec controller ls /data/profiles/ 2>&1 || true`,
    ).toString().trim();
    expect(out).not.toContain(`agent-${sessionId}`);
  });
});
