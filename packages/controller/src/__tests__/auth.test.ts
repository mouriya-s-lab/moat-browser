import { describe, test, expect, beforeAll } from "bun:test";
import { verifyToken } from "../auth.js";

// ---------------------------------------------------------------------------
// Helper: create a test JWT with HMAC-SHA256
// ---------------------------------------------------------------------------

async function makeToken(
  payload: Record<string, unknown>,
  secret: string = "dev-secret-change-in-prod"
): Promise<string> {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${body}`));
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const sigB64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `${header}.${body}.${sigB64}`;
}

const now = Math.floor(Date.now() / 1000);

describe("verifyToken", () => {
  test("valid token returns payload", async () => {
    const token = await makeToken({ agentId: "agent-1", iat: now, exp: now + 3600 });
    const result = await verifyToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.agentId).toBe("agent-1");
    }
  });

  test("wrong format returns AuthError", async () => {
    const result = await verifyToken("not.a.valid.jwt.token");
    expect(result.ok).toBe(false);
  });

  test("expired token returns AuthError", async () => {
    const token = await makeToken({ agentId: "agent-1", iat: now - 7200, exp: now - 3600 });
    const result = await verifyToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AuthError");
      expect(result.error.message).toContain("expired");
    }
  });

  test("wrong signature returns AuthError", async () => {
    const validToken = await makeToken({ agentId: "agent-1", iat: now, exp: now + 3600 });
    const parts = validToken.split(".");
    // Tamper with signature
    const tampered = `${parts[0]}.${parts[1]}.invalidsignature`;
    const result = await verifyToken(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AuthError");
    }
  });

  test("missing fields returns AuthError", async () => {
    // Payload missing required fields
    const token = await makeToken({ foo: "bar" });
    const result = await verifyToken(token);
    expect(result.ok).toBe(false);
  });
});
