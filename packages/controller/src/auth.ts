// JWT verification — verifyJWT(token, secret) → TokenPayload | GatewayError
// Uses jose for HMAC-SHA256 verification + arktype for payload validation
import { type } from "arktype";
import { jwtVerify } from "jose";
import { TokenPayloadSchema } from "@moat-browser/types";
import type { TokenPayload, GatewayError } from "@moat-browser/types";

export async function verifyJWT(
  token: string,
  secret: string
): Promise<TokenPayload | GatewayError> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, {
      issuer: "moat-browser",
      audience: "moat-browser-controller",
    });

    const result = TokenPayloadSchema(payload as Record<string, unknown>);
    if (result instanceof type.errors) {
      return {
        _tag: "AuthenticationFailed",
        reason: `Invalid token payload: ${result.summary}`,
      };
    }

    return result;
  } catch (err) {
    return {
      _tag: "AuthenticationFailed",
      reason: String(err),
    };
  }
}
