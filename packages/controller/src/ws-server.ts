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

  // Persistent CDP connection cache — survives ws close, keyed by sessionId
  const cdpCache = new Map<string, CdpConnection>();

  return { handleConnection, onSessionExpired };

  function handleConnection(ws: WebSocket): void {
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
            const response = await handleRegister(parsed.profile);
            ws.send(JSON.stringify(response));
            break;
          }

          case "command": {
            const response = await handleCommand(parsed.sessionId, parsed.command);
            ws.send(JSON.stringify(response));
            break;
          }

          case "deregister": {
            const response = await handleDeregister(parsed.sessionId);
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

    // ws close is a no-op for session state — sessions live until idle timeout or explicit deregister
  }

  // ─── register 全链路 (§10) ───

  async function handleRegister(
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

    // Step 5: Cache CDP connection + listen for browser disconnect
    cdpCache.set(sessionId, cdp);
    setupBrowserDisconnectHandler(cdp.browser, sessionId);

    return { type: "register_result", success: true, sessionId };
  }

  // ─── command (stateless — looks up CDP from cache) ───

  async function handleCommand(
    sessionId: string,
    command: Parameters<typeof executeCommand>[1],
  ): Promise<WireResponse> {
    // close → deregister
    if (command.action === "close") {
      return handleDeregister(sessionId);
    }

    // Verify session is active
    const activeResult = registry.getActive(sessionId);
    if (activeResult._tag === "Err") {
      return errorToWireResponse(sessionId, activeResult.error);
    }

    // Look up CDP from persistent cache
    const cdp = cdpCache.get(sessionId);
    if (!cdp) {
      return errorToWireResponse(sessionId, {
        _tag: "CdpDisconnected",
        containerId: activeResult.value.containerId,
      });
    }

    registry.touchActivity(sessionId);

    const result = await executeCommand(cdp.context, command, refStore, sessionId);
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
    const cdp = cdpCache.get(sessionId);
    if (cdp) {
      try {
        await cdp.browser.close();
      } catch {
        // best-effort
      }
    }

    // Step 3: Destroy container
    await containerManager.destroy(sessionId);

    // Cleanup
    cdpCache.delete(sessionId);

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

      // Cleanup CDP cache
      cdpCache.delete(sessionId);
    });
  }

  // ─── onSessionExpired (called by idle scanner) ───

  function onSessionExpired(sessionId: string, _reason: string): void {
    const cdp = cdpCache.get(sessionId);
    if (cdp) {
      cdp.browser.close().catch(() => {});
    }
    containerManager.destroy(sessionId).catch(() => {});
    cdpCache.delete(sessionId);
  }
}
