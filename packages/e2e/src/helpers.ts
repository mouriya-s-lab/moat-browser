import { createHmac } from "node:crypto";
import type { BrowserResult, GatewayError } from "@moat-browser/types";

// --- Test configuration ---

export const TEST_CONFIG = {
  controllerUrl: process.env.CONTROLLER_URL ?? "http://localhost:3000",
  jwtSecret: process.env.JWT_SECRET ?? "test-secret",
  webappUrl: "http://test-webapp",
  profileDir: "/tmp/moat-e2e/profile",
  profilesDir: "/tmp/moat-e2e/profiles",
} as const;

// --- JWT helper ---

export function createTestToken(agentId: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      agentId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString("base64url");
  const signature = createHmac("sha256", TEST_CONFIG.jwtSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

// --- ADT assertion helpers ---

export function assertResult<Tag extends BrowserResult["_tag"]>(
  result: BrowserResult | GatewayError,
  tag: Tag
): Extract<BrowserResult, { readonly _tag: Tag }> {
  if ("_tag" in result && result._tag === tag) {
    return result as Extract<BrowserResult, { readonly _tag: Tag }>;
  }
  throw new Error(`Expected ${tag}, got ${JSON.stringify(result)}`);
}

export function assertError<Tag extends GatewayError["_tag"]>(
  result: BrowserResult | GatewayError,
  tag: Tag
): Extract<GatewayError, { readonly _tag: Tag }> {
  if ("_tag" in result && result._tag === tag) {
    return result as Extract<GatewayError, { readonly _tag: Tag }>;
  }
  throw new Error(`Expected error ${tag}, got ${JSON.stringify(result)}`);
}

// --- Port wait helper ---

export async function waitForPort(
  host: string,
  port: number,
  opts?: { timeoutMs?: number; intervalMs?: number }
): Promise<boolean> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 30000);
  const interval = opts?.intervalMs ?? 500;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://${host}:${port}/`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) return true;
    } catch {
      // Not ready
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

// --- Docker Compose helper ---

export async function composeExec(
  service: string,
  command: string[]
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(
    [
      "docker",
      "compose",
      "-f",
      "packages/e2e/docker-compose.test.yml",
      "exec",
      "-T",
      service,
      ...command,
    ],
    {
      cwd: "/root/work/brpc",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

export async function composePs(): Promise<string> {
  const proc = Bun.spawn(
    [
      "docker",
      "compose",
      "-f",
      "packages/e2e/docker-compose.test.yml",
      "ps",
      "--format",
      "json",
    ],
    {
      cwd: "/root/work/brpc",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}
