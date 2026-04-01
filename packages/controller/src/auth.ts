/**
 * auth.ts — JWT verification for agent tokens
 *
 * Uses native crypto (HMAC-SHA256) to verify tokens without external JWT libs.
 * Token format: standard JWT with TokenPayload claims.
 */

import { type } from "arktype";
import { TokenPayloadSchema } from "@moat-browser/types";
import type { TokenPayload } from "@moat-browser/types";
import type { GatewayError } from "@moat-browser/types";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function base64urlDecode(input: string): Uint8Array {
  // Normalize base64url to base64
  const base64 = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function hmacSHA256(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  // base64url encode the signature
  const bytes = new Uint8Array(sig);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ---------------------------------------------------------------------------
// verifyToken
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { readonly ok: true; readonly payload: TokenPayload }
  | { readonly ok: false; readonly error: { readonly _tag: "AuthError"; readonly message: string } };

/**
 * Verify a JWT token and return the decoded payload.
 * Returns GatewayError on invalid/expired tokens.
 */
export async function verifyToken(token: string): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      error: { _tag: "AuthError", message: "Invalid token format" },
    };
  }

  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Verify signature
  const expectedSig = await hmacSHA256(config.jwtSecret, `${headerB64}.${payloadB64}`);
  if (expectedSig !== sigB64) {
    return {
      ok: false,
      error: { _tag: "AuthError", message: "Invalid token signature" },
    };
  }

  // Decode payload
  let rawPayload: unknown;
  try {
    const decoded = new TextDecoder().decode(base64urlDecode(payloadB64));
    rawPayload = JSON.parse(decoded);
  } catch {
    return {
      ok: false,
      error: { _tag: "AuthError", message: "Token payload decode failed" },
    };
  }

  // Validate schema
  const parsed = TokenPayloadSchema(rawPayload);
  if (parsed instanceof type.errors) {
    return {
      ok: false,
      error: { _tag: "AuthError", message: `Token payload invalid: ${parsed.summary}` },
    };
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (parsed.exp < now) {
    return {
      ok: false,
      error: { _tag: "AuthError", message: "Token expired" },
    };
  }

  return { ok: true, payload: parsed };
}
