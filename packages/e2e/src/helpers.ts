/**
 * helpers.ts — E2E test utilities
 *
 * Provides:
 * - assertResult / assertError — ADT discriminated-union assertions
 * - waitForPort / waitForHealth — infrastructure readiness
 * - DockerHelper — docker compose lifecycle management
 * - makeToken — generate a test JWT signed with test secret
 * - createTestClient — factory for MoatBrowserClient in tests
 * - cleanAgentProfiles — remove agent profile copies
 */

import net from "net";
import { execSync, spawn } from "child_process";
import { join } from "path";
import type { BrowserResult, GatewayError } from "@moat-browser/types";
import { MoatBrowserClient } from "@moat-browser/shim";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TEST_GATEWAY = process.env["MOAT_BROWSER_GATEWAY"] ?? "http://localhost:9800";
export const TEST_JWT_SECRET =
  process.env["MOAT_BROWSER_JWT_SECRET"] ?? "test-secret-do-not-use-in-prod";
export const TEST_WEBAPP_URL =
  process.env["TEST_WEBAPP_URL"] ?? "http://localhost:8888";

// ---------------------------------------------------------------------------
// ADT assertions
// ---------------------------------------------------------------------------

/**
 * Assert that `result` has the given `_tag`.
 * Throws with a descriptive message if not, so tests fail clearly.
 */
export function assertResult<Tag extends BrowserResult["_tag"]>(
  result: BrowserResult | GatewayError,
  tag: Tag
): asserts result is Extract<BrowserResult, { _tag: Tag }> {
  if (result._tag !== tag) {
    throw new Error(
      `Expected BrowserResult._tag "${tag}" but got "${result._tag}"\n` +
        `Full value: ${JSON.stringify(result, null, 2)}`
    );
  }
}

/**
 * Assert that `error` has the given `_tag`.
 * Throws with a descriptive message if not.
 */
export function assertError<Tag extends GatewayError["_tag"]>(
  error: BrowserResult | GatewayError,
  tag: Tag
): asserts error is Extract<GatewayError, { _tag: Tag }> {
  if (error._tag !== tag) {
    throw new Error(
      `Expected GatewayError._tag "${tag}" but got "${error._tag}"\n` +
        `Full value: ${JSON.stringify(error, null, 2)}`
    );
  }
}

/**
 * Assert that a result is NOT a CommandError.
 * Use in B-group tests to enforce that browser operations must succeed.
 */
export function assertNotCommandError(
  result: BrowserResult | GatewayError,
  context: string
): void {
  if (result._tag === "CommandError") {
    const err = result as Extract<GatewayError, { _tag: "CommandError" }>;
    throw new Error(
      `[${context}] Browser operation returned CommandError — this is a test FAILURE.\n` +
        `Command: ${err.command}\nMessage: ${err.message}\n\n` +
        `CommandError is not acceptable here. Fix the controller/CDP bridge.`
    );
  }
}

// ---------------------------------------------------------------------------
// waitForPort — poll TCP port until it accepts connections
// ---------------------------------------------------------------------------

export async function waitForPort(
  port: number,
  opts: { host?: string; timeout?: number } = {}
): Promise<void> {
  const host = opts.host ?? "127.0.0.1";
  const timeout = opts.timeout ?? 30_000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ host, port });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `[waitForPort] Port ${host}:${port} not available after ${timeout}ms.\n` +
      `Is the Docker Compose stack running? Run: cd packages/e2e && docker compose -f docker-compose.test.yml up -d --build --wait`
  );
}

// ---------------------------------------------------------------------------
// waitForHealth — poll HTTP endpoint until it returns 2xx
// ---------------------------------------------------------------------------

export async function waitForHealth(
  url: string,
  opts: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 30_000;
  const interval = opts.interval ?? 1_000;
  const deadline = Date.now() + timeout;

  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(
    `[waitForHealth] ${url} not healthy after ${timeout}ms. Last error: ${lastErr}\n` +
      `Is the Docker Compose stack running?`
  );
}

// ---------------------------------------------------------------------------
// DockerHelper — docker compose lifecycle
// ---------------------------------------------------------------------------

const COMPOSE_FILE = join(import.meta.dir, "..", "docker-compose.test.yml");

export class DockerHelper {
  private readonly composePath: string;

  private constructor(composePath: string) {
    this.composePath = composePath;
  }

  /**
   * Bring up the compose stack and wait for it to be healthy.
   * If `services` is specified, only those services are started.
   */
  static async up(
    composePath: string = COMPOSE_FILE,
    services: string[] = []
  ): Promise<DockerHelper> {
    const helper = new DockerHelper(composePath);
    const svcArgs = services.join(" ");
    execSync(
      `docker compose -f ${composePath} up -d --build --wait ${svcArgs}`,
      { stdio: "inherit" }
    );
    return helper;
  }

  /** Tear down the compose stack and remove volumes. */
  async down(): Promise<void> {
    execSync(`docker compose -f ${this.composePath} down -v --remove-orphans`, {
      stdio: "inherit",
    });
  }

  /** Fetch logs for a specific service. */
  async logs(service: string): Promise<string> {
    const buf = execSync(
      `docker compose -f ${this.composePath} logs --no-color ${service}`
    );
    return buf.toString();
  }

  /** Execute a command inside a running service container. */
  async exec(service: string, cmd: string[]): Promise<string> {
    const buf = execSync(
      `docker compose -f ${this.composePath} exec -T ${service} ${cmd.join(" ")}`
    );
    return buf.toString();
  }
}

// ---------------------------------------------------------------------------
// makeToken — generate a HS256 JWT signed with TEST_JWT_SECRET
// ---------------------------------------------------------------------------

function base64urlEncode(data: string | Uint8Array): string {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function hmacSHA256(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return base64urlEncode(new Uint8Array(sig));
}

export interface TokenOptions {
  agentId?: string;
  secret?: string;
  /** Expiry offset in seconds (default: +3600) */
  expiresIn?: number;
  /** Override iat and exp directly (for testing expired tokens) */
  iat?: number;
  exp?: number;
}

/**
 * Create a signed JWT for use in tests.
 * Defaults to the TEST_JWT_SECRET and 1-hour expiry.
 */
export async function makeToken(opts: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const agentId = opts.agentId ?? `test-agent-${crypto.randomUUID()}`;
  const secret = opts.secret ?? TEST_JWT_SECRET;
  const iat = opts.iat ?? now;
  const exp = opts.exp ?? iat + (opts.expiresIn ?? 3600);

  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64urlEncode(
    JSON.stringify({ sub: agentId, agentId, iat, exp })
  );
  const sig = await hmacSHA256(secret, `${header}.${payload}`);
  return `${header}.${payload}.${sig}`;
}

// ---------------------------------------------------------------------------
// createTestClient — factory for MoatBrowserClient in tests
// ---------------------------------------------------------------------------

export interface TestClientOptions {
  gateway?: string;
  token?: string;
  agentId?: string;
}

/**
 * Create a MoatBrowserClient pre-configured for the test environment.
 * Generates a signed token if none is provided.
 */
export async function createTestClient(
  opts: TestClientOptions = {}
): Promise<MoatBrowserClient> {
  const agentId = opts.agentId ?? `test-agent-${crypto.randomUUID()}`;
  const token = opts.token ?? (await makeToken({ agentId }));
  const gateway = opts.gateway ?? TEST_GATEWAY;

  return new MoatBrowserClient({ gateway, token, agentId });
}

// ---------------------------------------------------------------------------
// cleanAgentProfiles — remove agent profile copies in the test volume
// ---------------------------------------------------------------------------

export async function cleanAgentProfiles(): Promise<void> {
  try {
    execSync(
      `docker compose -f ${COMPOSE_FILE} exec -T controller sh -c "rm -rf /data/profiles/agents/*"`,
      { stdio: "pipe" }
    );
  } catch {
    // Ignore if container not running
  }
}
