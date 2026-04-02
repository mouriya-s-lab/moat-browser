import { createHmac } from "node:crypto";

interface JwtPayload {
  readonly agentId: string;
  readonly iat: number;
  readonly exp: number;
}

type AuthError = { readonly _tag: "AuthError"; readonly message: string };

export function verifyToken(
  token: string,
  secret: string
): JwtPayload | AuthError {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { _tag: "AuthError", message: "Invalid token format" };
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  const expectedSig = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  if (signatureB64 !== expectedSig) {
    return { _tag: "AuthError", message: "Invalid token signature" };
  }

  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString()
    );

    if (payload.exp && payload.exp < Date.now() / 1000) {
      return { _tag: "AuthError", message: "Token expired" };
    }

    if (!payload.agentId || typeof payload.agentId !== "string") {
      return { _tag: "AuthError", message: "Missing agentId in token" };
    }

    return {
      agentId: payload.agentId,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return { _tag: "AuthError", message: "Invalid token payload" };
  }
}

export function createToken(agentId: string, secret: string): string {
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
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}
