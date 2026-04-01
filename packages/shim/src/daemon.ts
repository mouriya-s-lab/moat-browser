/**
 * daemon.ts — Unix socket daemon mode
 *
 * Listens on a Unix socket, accepts JSON-line commands,
 * forwards them to the controller via MoatBrowserClient,
 * and writes JSON-line responses back.
 *
 * Protocol: agent-browser-session JSON-line format
 *   Request:  { id: string, command: string, ...params }\n
 *   Response: { id: string, ok: true, result: BrowserResult }\n
 *          or { id: string, ok: false, error: GatewayError }\n
 */

import { createServer, type Server, type Socket as NetSocket } from "net";
import { unlink, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { MoatBrowserClient } from "./client.js";
import {
  parseWireLine,
  wireToCommand,
  resultToWire,
  errorToWire,
  serializeWireResponse,
} from "./protocol-bridge.js";
import type { GatewayError } from "@moat-browser/types";

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

export interface DaemonOptions {
  gateway: string;
  token: string;
  agentId: string;
  socketPath: string;
}

export class ShimDaemon {
  private readonly _client: MoatBrowserClient;
  private readonly _socketPath: string;
  private _server: Server | null = null;

  constructor(opts: DaemonOptions) {
    this._client = new MoatBrowserClient({
      gateway: opts.gateway,
      token: opts.token,
      agentId: opts.agentId,
    });
    this._socketPath = opts.socketPath;
  }

  /** Start the daemon: connect to gateway, then listen on Unix socket. */
  async start(): Promise<void> {
    // Connect to gateway
    const connectResult = await this._client.connect();
    if ("_tag" in connectResult) {
      throw new Error(`Failed to connect to gateway: ${JSON.stringify(connectResult)}`);
    }

    console.log(`[shim-daemon] connected, sessionId=${connectResult.sessionId}`);

    // Ensure socket directory exists
    const dir = dirname(this._socketPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Remove stale socket
    if (existsSync(this._socketPath)) {
      await unlink(this._socketPath);
    }

    // Start Unix socket server
    this._server = createServer((socket: NetSocket) => {
      let buffer = "";

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        // Last element may be incomplete
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          void this._handleLine(trimmed).then((resp) => {
            socket.write(serializeWireResponse(resp));
          });
        }
      });

      socket.on("error", (err: Error) => {
        console.error("[shim-daemon] socket error:", err.message);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this._server!.once("error", reject);
      this._server!.listen(this._socketPath, () => {
        console.log(`[shim-daemon] listening on ${this._socketPath}`);
        resolve();
      });
    });
  }

  /** Stop the daemon. */
  async stop(): Promise<void> {
    await this._client.disconnect();

    if (this._server) {
      await new Promise<void>((resolve) => {
        this._server!.close(() => resolve());
      });
      this._server = null;
    }

    if (existsSync(this._socketPath)) {
      await unlink(this._socketPath).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async _handleLine(
    line: string
  ): Promise<ReturnType<typeof resultToWire> | ReturnType<typeof errorToWire>> {
    const wireReq = parseWireLine(line);
    if (isGatewayError(wireReq)) {
      return errorToWire("unknown", wireReq);
    }

    const { id } = wireReq;
    const cmd = wireToCommand(wireReq);
    if (isGatewayError(cmd)) {
      return errorToWire(id, cmd);
    }

    const result = await this._client.command(cmd);
    if (isGatewayError(result)) {
      return errorToWire(id, result);
    }

    return resultToWire(id, result);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GATEWAY_ERROR_TAGS = new Set<string>([
  "AuthError",
  "SessionNotFound",
  "SessionExpired",
  "ContainerError",
  "CDPError",
  "CommandError",
  "ValidationError",
  "InternalError",
]);

function isGatewayError(x: unknown): x is GatewayError {
  if (typeof x !== "object" || x === null) return false;
  const tag = (x as Record<string, unknown>)["_tag"];
  return typeof tag === "string" && GATEWAY_ERROR_TAGS.has(tag);
}
