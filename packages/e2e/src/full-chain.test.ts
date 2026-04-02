import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { io, type Socket } from "socket.io-client";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { connect, type BrowserClient } from "@moat-browser/shim";
import { TEST_CONFIG, createTestToken } from "./helpers";
import { ensureEnvironment } from "./setup";

/**
 * Full chain E2E tests covering:
 * ac-2: Full lifecycle (connect → navigate → click → fill → snapshot → screenshot → disconnect)
 * ac-3: Profile bridge (user-chrome writes file → freeze → agent sees it)
 * ac-4: Multi-agent parallel
 * ac-5: Fault recovery (container kill → session error)
 */

function profileSocket(): Promise<Socket> {
  return new Promise<Socket>((resolve) => {
    const s = io(TEST_CONFIG.controllerUrl, {
      autoConnect: false,
      timeout: 10000,
    });
    s.on("connect", () => resolve(s));
    s.connect();
  });
}

async function freezeProfile(): Promise<void> {
  const s = await profileSocket();
  await new Promise<unknown>((r) => s.emit("unfreezeProfile", r)).catch(
    () => {}
  );
  await new Promise<unknown>((r) => s.emit("freezeProfile", r));
  s.disconnect();
}

async function unfreezeProfile(): Promise<void> {
  const s = await profileSocket();
  await new Promise<unknown>((r) => s.emit("unfreezeProfile", r)).catch(
    () => {}
  );
  s.disconnect();
}

describe("Full chain: lifecycle (ac-2)", () => {
  let client: BrowserClient | undefined;

  beforeAll(async () => {
    await ensureEnvironment();
    await freezeProfile();
  });

  afterAll(async () => {
    if (client) await client.disconnect().catch(() => {});
    await unfreezeProfile();
  });

  test("connect → navigate → click → fill → snapshot → screenshot → disconnect", async () => {
    // connect
    const token = createTestToken("e2e-fullchain");
    const result = await connect(TEST_CONFIG.controllerUrl, token);
    if ("_tag" in result) throw new Error(`connect: ${JSON.stringify(result)}`);
    client = result;
    expect(client.sessionId).toBeDefined();

    // navigate
    const nav = await client.navigate(TEST_CONFIG.webappUrl);
    expect(nav._tag).toBe("NavigateResult");
    if (nav._tag === "NavigateResult") {
      expect(nav.title).toBe("Moat Test Page");
    }

    // fill
    const fill = await client.fill("#username", "fullchain-user");
    expect(fill._tag).toBe("FillResult");

    // click
    const click = await client.click("#login-btn");
    expect(click._tag).toBe("ClickResult");

    // snapshot
    const snap = await client.snapshot();
    expect(snap._tag).toBe("SnapshotResult");
    if (snap._tag === "SnapshotResult") {
      expect(snap.aria).toContain("Hello");
    }

    // screenshot
    const ss = await client.screenshot();
    expect(ss._tag).toBe("ScreenshotResult");
    if (ss._tag === "ScreenshotResult") {
      expect(ss.png.length).toBeGreaterThan(100);
    }

    // disconnect
    await client.disconnect();
    client = undefined;
  }, 120000);
});

describe("Full chain: profile bridge (ac-3)", () => {
  let client: BrowserClient | undefined;
  const markerFile = path.join(TEST_CONFIG.profileDir, "bridge-marker.txt");
  const markerContent = `bridge-test-${Date.now()}`;

  beforeAll(async () => {
    await ensureEnvironment();
    // Ensure unfrozen before writing
    await unfreezeProfile();
    // Write a marker file to the profile source directory
    await fs.writeFile(markerFile, markerContent, "utf-8");
    // Freeze profile so agent registration can copy it
    await freezeProfile();
  });

  afterAll(async () => {
    if (client) await client.disconnect().catch(() => {});
    await unfreezeProfile();
    await fs.unlink(markerFile).catch(() => {});
  });

  test("agent profile copy contains marker file from source", async () => {
    const token = createTestToken("e2e-bridge");
    const result = await connect(TEST_CONFIG.controllerUrl, token);
    if ("_tag" in result) throw new Error(`connect: ${JSON.stringify(result)}`);
    client = result;

    // The controller copied the profile to /tmp/moat-e2e/profiles/agent-{sessionId}
    const agentProfileDir = path.join(
      TEST_CONFIG.profilesDir,
      `agent-${client.sessionId}`
    );
    const copiedMarker = path.join(agentProfileDir, "bridge-marker.txt");

    // Verify the marker file was copied
    const content = await fs.readFile(copiedMarker, "utf-8");
    expect(content).toBe(markerContent);

    // Verify .frozen marker was removed from the copy
    const frozenInCopy = path.join(agentProfileDir, ".frozen");
    const frozenExists = await fs
      .access(frozenInCopy)
      .then(() => true)
      .catch(() => false);
    expect(frozenExists).toBe(false);

    await client.disconnect();
    client = undefined;
  }, 60000);
});

describe("Full chain: multi-agent parallel (ac-4)", () => {
  let client1: BrowserClient | undefined;
  let client2: BrowserClient | undefined;

  beforeAll(async () => {
    await ensureEnvironment();
    await freezeProfile();
  });

  afterAll(async () => {
    if (client1) await client1.disconnect().catch(() => {});
    if (client2) await client2.disconnect().catch(() => {});
    await unfreezeProfile();
  });

  test("two agents connect and operate independently", async () => {
    // Connect both agents
    const token1 = createTestToken("e2e-parallel-1");
    const token2 = createTestToken("e2e-parallel-2");

    const [result1, result2] = await Promise.all([
      connect(TEST_CONFIG.controllerUrl, token1),
      connect(TEST_CONFIG.controllerUrl, token2),
    ]);

    if ("_tag" in result1)
      throw new Error(`agent1 connect: ${JSON.stringify(result1)}`);
    if ("_tag" in result2)
      throw new Error(`agent2 connect: ${JSON.stringify(result2)}`);

    client1 = result1;
    client2 = result2;

    expect(client1.sessionId).not.toBe(client2.sessionId);

    // Both navigate to test-webapp
    const [nav1, nav2] = await Promise.all([
      client1.navigate(TEST_CONFIG.webappUrl),
      client2.navigate(TEST_CONFIG.webappUrl),
    ]);
    expect(nav1._tag).toBe("NavigateResult");
    expect(nav2._tag).toBe("NavigateResult");

    // Each fills different values
    const [fill1, fill2] = await Promise.all([
      client1.fill("#username", "agent-1"),
      client2.fill("#username", "agent-2"),
    ]);
    expect(fill1._tag).toBe("FillResult");
    expect(fill2._tag).toBe("FillResult");

    // Each clicks login
    await Promise.all([
      client1.click("#login-btn"),
      client2.click("#login-btn"),
    ]);

    // Each evaluates — should see their own value
    const [eval1, eval2] = await Promise.all([
      client1.evaluate("document.getElementById('message').textContent"),
      client2.evaluate("document.getElementById('message').textContent"),
    ]);

    expect(eval1._tag).toBe("EvaluateResult");
    expect(eval2._tag).toBe("EvaluateResult");
    if (eval1._tag === "EvaluateResult" && eval2._tag === "EvaluateResult") {
      expect(eval1.value).toBe("Hello, agent-1!");
      expect(eval2.value).toBe("Hello, agent-2!");
    }

    // Disconnect both
    await Promise.all([client1.disconnect(), client2.disconnect()]);
    client1 = undefined;
    client2 = undefined;
  }, 120000);
});

describe("Full chain: fault recovery (ac-5)", () => {
  beforeAll(async () => {
    await ensureEnvironment();
    await freezeProfile();
  });

  afterAll(async () => {
    await unfreezeProfile();
  });

  test("container kill causes session error", async () => {
    const token = createTestToken("e2e-fault");
    const result = await connect(TEST_CONFIG.controllerUrl, token);
    if ("_tag" in result) throw new Error(`connect: ${JSON.stringify(result)}`);
    const client = result;

    // Navigate to verify session is active
    const nav = await client.navigate(TEST_CONFIG.webappUrl);
    expect(nav._tag).toBe("NavigateResult");

    // Find and kill the agent-chrome container for this session
    const agentProfileDir = path.join(
      TEST_CONFIG.profilesDir,
      `agent-${client.sessionId}`
    );
    // List containers to find the one using this profile
    const proc = Bun.spawn(
      [
        "docker",
        "ps",
        "--filter",
        `volume=${agentProfileDir}`,
        "--format",
        "{{.ID}}",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    let containerId = (await new Response(proc.stdout).text()).trim();
    await proc.exited;

    // Fallback: find containers with the agent-chrome image
    if (!containerId) {
      const proc2 = Bun.spawn(
        [
          "docker",
          "ps",
          "--filter",
          "ancestor=moat-agent-chrome",
          "--format",
          "{{.ID}}",
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      const ids = (await new Response(proc2.stdout).text()).trim();
      await proc2.exited;
      // Take the last one (most recently created)
      const idList = ids.split("\n").filter(Boolean);
      containerId = idList[idList.length - 1] ?? "";
    }

    if (containerId) {
      // Kill the container
      const kill = Bun.spawn(["docker", "kill", containerId], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await kill.exited;

      // Wait a moment for the controller to detect the failure
      await new Promise((r) => setTimeout(r, 3000));

      // Attempt a command — should get an error
      const cmdResult = await client.navigate(TEST_CONFIG.webappUrl);
      expect(cmdResult._tag).toMatch(
        /SessionExpired|CommandError|ContainerError/
      );
    }

    // Client disconnect (best effort)
    await client.disconnect().catch(() => {});
  }, 60000);
});
