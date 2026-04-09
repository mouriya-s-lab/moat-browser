import type { WebSocket } from "ws";
import type { Browser } from "patchright";
import {
  type ControllerError,
  type WireRequest,
  type WireResponse,
  ErrorCode,
  exhaustive,
  wireRequestSchema,
} from "@moat-browser/types";
import { type } from "arktype";
import type { SessionRegistry } from "./session-registry.js";
import type { ContainerManager } from "./container-manager.js";
import type { RefStore } from "./ref-store.js";
import { connectCDP, executeCommand, type CdpConnection } from "./cdp-bridge.js";
import type { ControllerConfig } from "./index.js";
import path from "node:path";

// ─── Per-connection state ───

type ConnectionState = {
  sessionId: string | undefined;
  cdp: CdpConnection | undefined;
};

// ─── Profile path resolution ───

function resolveProfilePath(
  profile: string | undefined,
  defaultSource: string,
): string {
  if (!profile || profile === "default") return defaultSource;
  if (path.isAbsolute(profile)) return profile;
  return path.join(path.dirname(defaultSource), profile);
}

// ─── errorToWireResponse (§11.2) ───

function formatError(error: ControllerError): string {
  switch (error._tag) {
    case "SessionNotFound":
      return `Session not found: ${error.sessionId}`;
    case "SessionExpired":
      return `Session expired: ${error.reason}`;
    case "SessionNotReady":
      return `Session not ready (state: ${error.state})`;
    case "ContainerCreateFailed":
      return `Container creation failed: ${error.message}`;
    case "CdpUnreachable":
      return `CDP unreachable for container ${error.containerId}`;
    case "CdpDisconnected":
      return `CDP disconnected for container ${error.containerId}`;
    case "ProfileCopyFailed":
      return `Profile copy failed: ${error.message}`;
    case "ElementNotFound":
      return `Element not found${error.selector ? `: ${error.selector}` : ""}`;
    case "Timeout":
      return `Timeout: ${error.operation}`;
    case "CommandFailed":
      return `Command failed: ${error.message}`;
    case "ValidationFailed":
      return `Validation failed: ${error.message}`;
    default:
      return exhaustive(error);
  }
}

function errorToWireResponse(sessionId: string, error: ControllerError): WireResponse {
  return {
    type: "command_result",
    sessionId,
    success: false,
    error: formatError(error),
    code: ErrorCode[error._tag],
  };
}

// ─── WsHandler ───

export type WsHandlerDeps = {
  readonly registry: SessionRegistry;
  readonly containerManager: ContainerManager;
  readonly refStore: RefStore;
  readonly config: ControllerConfig;
};

export type WsHandler = {
  handleConnection(ws: WebSocket): void;
  onSessionExpired(sessionId: string, reason: string): void;
};

export function createWsHandler(deps: WsHandlerDeps): WsHandler {
  const { registry, containerManager, refStore, config } = deps;

  // Track ws ↔ session binding for disconnect cleanup and CDP disconnect
  const sessionConnections = new Map<string, { ws: WebSocket; cdp: CdpConnection | undefined }>();

  return { handleConnection, onSessionExpired };

  function handleConnection(ws: WebSocket): void {
    const conn: ConnectionState = { sessionId: undefined, cdp: undefined };

    ws.on("message", async (raw) => {
      try {
        let data: unknown;
        try {
          data = JSON.parse(String(raw));
        } catch {
          ws.send(JSON.stringify({ type: "error", error: "Invalid request", code: 2 }));
          return;
        }

        const validated = wireRequestSchema(data);
        if (validated instanceof type.errors) {
          ws.send(JSON.stringify({ type: "error", error: "Invalid request", code: 2 }));
          return;
        }
        // Third-party library interaction — arktype infer union needs explicit cast
        const parsed = validated as WireRequest;

        switch (parsed.type) {
          case "register": {
            const response = await handleRegister(conn, parsed.profile);
            ws.send(JSON.stringify(response));
            if (response.type === "register_result" && response.success) {
              sessionConnections.set(conn.sessionId!, { ws, cdp: conn.cdp });
            }
            break;
          }

          case "resume": {
            const response = await handleResume(conn, parsed.sessionId);
            ws.send(JSON.stringify(response));
            if (response.type === "register_result" && response.success) {
              sessionConnections.set(conn.sessionId!, { ws, cdp: conn.cdp });
            }
            break;
          }

          case "command": {
            const response = await handleCommand(conn, parsed.sessionId, parsed.command);
            ws.send(JSON.stringify(response));
            break;
          }

          case "deregister": {
            const response = await handleDeregister(conn, parsed.sessionId);
            ws.send(JSON.stringify(response));
            break;
          }

          default:
            exhaustive(parsed);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Unhandled message error:", msg);
        try {
          ws.send(JSON.stringify({ type: "error", error: `Internal error: ${msg}`, code: 1 }));
        } catch {
          // ws already closed
        }
      }
    });

    ws.on("close", () => {
      if (conn.sessionId) {
        registry.markDisconnected(conn.sessionId);
        sessionConnections.delete(conn.sessionId);
      }
    });
  }

  // ─── register 全链路 (§10) ───

  async function handleRegister(
    conn: ConnectionState,
    profile?: string,
  ): Promise<WireResponse> {
    // Step 1: SessionRegistry.register()
    const regResult = registry.register(profile);
    if (regResult._tag === "Err") {
      return {
        type: "register_result",
        success: false,
        error: formatError(regResult.error),
        code: ErrorCode[regResult.error._tag],
      };
    }
    const sessionId = regResult.value;

    // Step 2: ContainerManager.create() — transition through states
    const profilePath = resolveProfilePath(profile, config.profileSource);

    registry.transition(sessionId, { _tag: "CreatingContainer", profilePath });

    const containerResult = await containerManager.create(sessionId, profilePath);
    if (containerResult._tag === "Err") {
      // Rollback: deregister session
      registry.deregister(sessionId);
      return {
        type: "register_result",
        success: false,
        error: formatError(containerResult.error),
        code: ErrorCode[containerResult.error._tag],
      };
    }

    const { containerId, ip } = containerResult.value;
    registry.transition(sessionId, { _tag: "ConnectingCDP", containerId });

    // Step 3: CdpBridge.connect()
    let cdp: CdpConnection;
    try {
      cdp = await connectCDP(`http://${ip}:9222`);
    } catch (e) {
      // Rollback: destroy container + deregister
      await containerManager.destroy(sessionId);
      registry.deregister(sessionId);
      return {
        type: "register_result",
        success: false,
        error: `CDP connection failed: ${e instanceof Error ? e.message : String(e)}`,
        code: ErrorCode.CdpUnreachable,
      };
    }

    // Step 4: Transition to Active
    const now = Date.now();
    registry.transition(sessionId, {
      _tag: "Active",
      containerId,
      containerIp: ip,
      cdpUrl: `http://${ip}:9222`,
      createdAt: now,
      lastActivity: now,
    });

    // Step 5: Listen for browser disconnect (§11.3)
    setupBrowserDisconnectHandler(cdp.browser, sessionId);

    // Bind connection
    conn.sessionId = sessionId;
    conn.cdp = cdp;

    return { type: "register_result", success: true, sessionId };
  }

  // ─── resume ───

  async function handleResume(
    conn: ConnectionState,
    sessionId: string,
  ): Promise<WireResponse> {
    const resumeResult = registry.resume(sessionId);
    if (resumeResult._tag === "Err") {
      return {
        type: "register_result",
        success: false,
        error: formatError(resumeResult.error),
        code: ErrorCode[resumeResult.error._tag],
      };
    }

    // Get the active session to retrieve CDP connection info
    const activeResult = registry.getActive(sessionId);
    if (activeResult._tag === "Err") {
      return {
        type: "register_result",
        success: false,
        error: formatError(activeResult.error),
        code: ErrorCode[activeResult.error._tag],
      };
    }

    // Re-connect CDP if needed
    const prev = sessionConnections.get(sessionId);
    let cdp = prev?.cdp;
    if (!cdp) {
      try {
        cdp = await connectCDP(activeResult.value.cdpUrl);
        setupBrowserDisconnectHandler(cdp.browser, sessionId);
      } catch (e) {
        return {
          type: "register_result",
          success: false,
          error: `CDP reconnect failed: ${e instanceof Error ? e.message : String(e)}`,
          code: ErrorCode.CdpUnreachable,
        };
      }
    }

    conn.sessionId = sessionId;
    conn.cdp = cdp;

    return { type: "register_result", success: true, sessionId };
  }

  // ─── command ───

  async function handleCommand(
    conn: ConnectionState,
    sessionId: string,
    command: Parameters<typeof executeCommand>[1],
  ): Promise<WireResponse> {
    // close → deregister
    if (command.action === "close") {
      return handleDeregister(conn, sessionId);
    }

    // Verify session is active
    const activeResult = registry.getActive(sessionId);
    if (activeResult._tag === "Err") {
      return errorToWireResponse(sessionId, activeResult.error);
    }

    // Ensure we have a CDP connection
    if (!conn.cdp) {
      return errorToWireResponse(sessionId, {
        _tag: "CdpDisconnected",
        containerId: activeResult.value.containerId,
      });
    }

    registry.touchActivity(sessionId);

    const result = await executeCommand(conn.cdp.context, command, refStore, sessionId);
    if (result._tag === "Err") {
      return errorToWireResponse(sessionId, result.error);
    }

    return {
      type: "command_result",
      sessionId,
      success: true,
      data: result.value,
    };
  }

  // ─── deregister ───

  async function handleDeregister(
    conn: ConnectionState,
    sessionId: string,
  ): Promise<WireResponse> {
    // Step 1: Deregister from registry
    const deregResult = registry.deregister(sessionId);
    if (deregResult._tag === "Err") {
      return {
        type: "deregister_result",
        sessionId,
        success: false,
      };
    }

    // Step 2: Disconnect CDP (close Patchright Browser)
    const entry = sessionConnections.get(sessionId);
    if (entry?.cdp) {
      try {
        await entry.cdp.browser.close();
      } catch {
        // best-effort
      }
    }

    // Step 3: Destroy container
    await containerManager.destroy(sessionId);

    // Cleanup
    sessionConnections.delete(sessionId);
    conn.sessionId = undefined;
    conn.cdp = undefined;

    return { type: "deregister_result", sessionId, success: true };
  }

  // ─── Browser disconnected handler (§11.3) ───

  function setupBrowserDisconnectHandler(browser: Browser, sessionId: string): void {
    browser.on("disconnected", async () => {
      // Session → Expired
      registry.transition(sessionId, {
        _tag: "Expired",
        reason: "CDP disconnected",
      });

      // Trigger container cleanup
      await containerManager.destroy(sessionId);

      // Notify connected client if still active
      const entry = sessionConnections.get(sessionId);
      if (entry) {
        const response = errorToWireResponse(sessionId, {
          _tag: "CdpDisconnected",
          containerId: "",
        });
        try {
          entry.ws.send(JSON.stringify(response));
        } catch {
          // ws already closed
        }
        sessionConnections.delete(sessionId);
      }
    });
  }

  // ─── onSessionExpired (called by idle scanner) ───

  function onSessionExpired(sessionId: string, reason: string): void {
    const entry = sessionConnections.get(sessionId);
    if (entry) {
      // Cleanup CDP
      if (entry.cdp) {
        entry.cdp.browser.close().catch(() => {});
      }
      // Cleanup container
      containerManager.destroy(sessionId).catch(() => {});
      sessionConnections.delete(sessionId);
    }
  }
}
