// Daemon mode — Unix socket server, JSON-line protocol bridge (design.md §6.1)
import net from "node:net";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { MoatBrowserClient } from "./client.js";
import { toBrowserCommand, buildResponse } from "./protocol-bridge.js";
import type { GatewayError } from "@moat-browser/types";

export interface DaemonOptions {
  readonly socketPath: string; // Unix socket path, e.g. /run/agent-browser/main.sock
  readonly gateway: string;    // Controller Socket.IO URL
  readonly token: string;
  readonly agentId: string;
}

export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const client = new MoatBrowserClient({
    gateway: opts.gateway,
    token: opts.token,
    agentId: opts.agentId,
  });

  // Step 1: Connect to Controller and register session
  const connectResult = await client.connect();
  if (isGatewayError(connectResult)) {
    throw new Error(
      `[daemon] Controller connect failed: ${connectResult._tag} — ${
        "reason" in connectResult ? connectResult.reason :
        "message" in connectResult ? (connectResult as { message: string }).message :
        JSON.stringify(connectResult)
      }`
    );
  }
  console.log(`[daemon] Registered session: ${connectResult.sessionId}`);

  // Step 2: Remove stale socket file if present
  if (existsSync(opts.socketPath)) {
    await unlink(opts.socketPath).catch(() => {});
  }

  // Step 3: Create Unix socket server
  const server = net.createServer((conn) => {
    let buffer = "";

    conn.setEncoding("utf8");

    conn.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      // Last element may be incomplete — keep it in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        handleLine(trimmed, conn);
      }
    });

    conn.on("error", (err) => {
      console.error("[daemon] Connection error:", err.message);
    });
  });

  server.listen(opts.socketPath, () => {
    console.log(`[daemon] Listening on ${opts.socketPath}`);
  });

  // Handle a single JSON-line command
  async function handleLine(line: string, conn: net.Socket): Promise<void> {
    let raw: unknown;
    let requestId: string | undefined;

    try {
      raw = JSON.parse(line);
      if (typeof raw === "object" && raw !== null && "id" in raw) {
        requestId = String((raw as { id: unknown }).id);
      }
    } catch {
      const errLine = JSON.stringify({
        success: false,
        error: `JSON parse error: ${line.slice(0, 80)}`,
      });
      conn.write(errLine + "\n");
      return;
    }

    const browserCmd = toBrowserCommand(raw);

    if (browserCmd._tag === "ProtocolError") {
      const errLine = JSON.stringify({
        id: requestId,
        success: false,
        error: browserCmd.message,
      });
      conn.write(errLine + "\n");
      return;
    }

    const result = await client.command(browserCmd);

    // GatewayError — not a BrowserResult
    if (isGatewayError(result)) {
      const errLine = JSON.stringify({
        id: requestId,
        success: false,
        error: `${result._tag}: ${"message" in result ? (result as { message: string }).message : JSON.stringify(result)}`,
      });
      conn.write(errLine + "\n");
      return;
    }

    const response = buildResponse(requestId, result);
    conn.write(JSON.stringify(response) + "\n");
  }

  // Step 4: Graceful shutdown on SIGTERM / SIGINT
  async function shutdown(signal: string): Promise<void> {
    console.log(`[daemon] ${signal} received, shutting down`);
    server.close();

    try {
      await client.disconnect();
    } catch {
      // Best-effort
    }

    try {
      await unlink(opts.socketPath);
    } catch {
      // Socket file may already be gone
    }

    process.exit(0);
  }

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  // Keep process alive (server is the event loop anchor)
  await new Promise<void>((resolve) => {
    server.once("close", resolve);
  });
}

function isGatewayError(value: unknown): value is GatewayError {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    [
      "AuthenticationFailed",
      "SessionNotFound",
      "SessionNotReady",
      "ContainerError",
      "CDPError",
      "InternalError",
    ].includes((value as { _tag: string })._tag)
  );
}
