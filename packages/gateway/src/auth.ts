import { createHmac } from "node:crypto";
import { config } from "./config.js";

export type AuthResult =
  | { readonly _tag: "Valid"; readonly agentId: string }
  | { readonly _tag: "Invalid"; readonly reason: string };

export function verifyToken(token: string): AuthResult {
  if (!config.jwtSecret) {
    // No secret configured — accept any non-empty token (dev mode)
    if (token.length > 0) {
      return { _tag: "Valid", agentId: "dev" };
    }
    return { _tag: "Invalid", reason: "empty token" };
  }

  // Simple HMAC-based token: base64(agentId):hmac-hex(agentId, secret)
  const parts = token.split(":");
  if (parts.length !== 2) {
    return { _tag: "Invalid", reason: "malformed token" };
  }

  try {
    const agentId = Buffer.from(parts[0]!, "base64").toString("utf-8");
    const expectedSig = createHmac("sha256", config.jwtSecret)
      .update(agentId)
      .digest("hex");

    if (parts[1] === expectedSig) {
      return { _tag: "Valid", agentId };
    }
    return { _tag: "Invalid", reason: "signature mismatch" };
  } catch {
    return { _tag: "Invalid", reason: "decode error" };
  }
}
