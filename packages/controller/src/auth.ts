import type { AuthError } from "@moat-browser/types";

type AuthResult =
  | { readonly _tag: "Ok"; readonly agentId: string }
  | AuthError;

function base64UrlDecode(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function verifyToken(token: string, secret: string): Promise<AuthResult> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { _tag: "AuthError", message: "malformed token" };
  }

  const headerB64 = parts[0]!;
  const payloadB64 = parts[1]!;
  const signatureB64 = parts[2]!;

  try {
    // Verify HMAC-SHA256 signature
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const signatureInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlDecode(signatureB64);

    const valid = await crypto.subtle.verify("HMAC", key, signature, signatureInput);
    if (!valid) {
      return { _tag: "AuthError", message: "invalid signature" };
    }

    // Decode payload
    const payloadBytes = base64UrlDecode(payloadB64);
    const json = new TextDecoder().decode(payloadBytes);
    const payload: unknown = JSON.parse(json);

    if (typeof payload !== "object" || payload === null) {
      return { _tag: "AuthError", message: "invalid payload" };
    }

    // Type-narrow without `as` — check each field
    const obj: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(payload)) {
      obj[k] = v;
    }

    // Check expiry
    if (typeof obj["exp"] === "number" && obj["exp"] < Date.now() / 1000) {
      return { _tag: "AuthError", message: "token expired" };
    }

    // Extract agent ID
    const sub = obj["sub"];
    if (typeof sub !== "string" || sub.length === 0) {
      return { _tag: "AuthError", message: "missing sub claim" };
    }

    return { _tag: "Ok", agentId: sub };
  } catch {
    return { _tag: "AuthError", message: "invalid token encoding" };
  }
}

// Helper to create a JWT with real HMAC-SHA256 for testing
export async function createTestToken(agentId: string, secret: string): Promise<string> {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const payload = btoa(
    JSON.stringify({
      sub: agentId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput)
  );

  const signature = base64UrlEncode(new Uint8Array(signatureBuffer));

  return `${header}.${payload}.${signature}`;
}
