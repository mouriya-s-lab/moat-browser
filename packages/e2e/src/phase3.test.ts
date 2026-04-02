import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ensureEnvironment } from "./setup";

describe("Phase 3: agent-chrome image", () => {
  let containerId: string | undefined;

  beforeAll(async () => {
    await ensureEnvironment();
  });

  afterAll(async () => {
    if (containerId) {
      const stop = Bun.spawn(["docker", "stop", "-t", "5", containerId], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await stop.exited;
      const rm = Bun.spawn(["docker", "rm", "-f", containerId], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await rm.exited;
    }
  });

  test("agent-chrome image exists", async () => {
    const proc = Bun.spawn(
      ["docker", "images", "moat-agent-chrome", "--format", "{{.Repository}}"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout.trim()).toBe("moat-agent-chrome");
  });

  test("agent-chrome container starts and CDP responds", async () => {
    // Create and start container on moat-test network
    const create = Bun.spawn(
      [
        "docker",
        "run",
        "-d",
        "--network",
        "moat-test",
        "moat-agent-chrome",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    containerId = (await new Response(create.stdout).text()).trim();
    const createCode = await create.exited;
    expect(createCode).toBe(0);
    expect(containerId.length).toBeGreaterThan(0);

    // Get container IP
    const inspect = Bun.spawn(
      [
        "docker",
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        containerId,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const ip = (await new Response(inspect.stdout).text()).trim();
    await inspect.exited;
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    // Wait for CDP endpoint
    const deadline = Date.now() + 60000;
    let cdpReady = false;
    while (Date.now() < deadline) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`http://${ip}:9222/json/version`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const data = (await res.json()) as { Browser?: string };
          expect(data.Browser).toBeDefined();
          cdpReady = true;
          break;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(cdpReady).toBe(true);
  }, 90000);
});
