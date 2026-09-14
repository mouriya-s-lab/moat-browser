import type { WebSocket } from "ws";
import type { Browser } from "patchright";
import { randomBytes } from "node:crypto";
import {
  type BrowserCommand,
  type ContentBoundary,
  type ControllerError,
  type WireFailure,
  type WireRequest,
  type WireResponse,
  ErrorCode,
  exhaustive,
  wireRequestSchema,
} from "@moat-browser/types";
import { type } from "arktype";
import type {
  ContainerManager,
  Result as ContainerResult,
} from "./container-manager.js";
import {
  resolveProfilePath,
} from "./container-manager.js";
import type { SessionRegistry } from "./session-registry.js";
import type { RefStore } from "./ref-store.js";
import { clearSessionRuntimeState, connectCDP, executeCommand, type CdpConnection } from "./cdp-bridge.js";
import type { ControllerConfig } from "./index.js";

// ─── errorToWireResponse (§11.2) ───

type CleanupStage = "command" | "cleanup";

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
    case "ProfileUnavailable": {
      const reason = error.reason;
      switch (reason) {
        case "invalid_name":
          return "Profile name is invalid; choose a registered profile name";
        case "not_registered":
          return "Profile name is not registered; choose a configured profile name";
        case "source_unavailable":
          return "Configured profile is unavailable; choose another registered profile name";
        default:
          return exhaustive(reason);
      }
    }
    case "ElementNotFound":
      return `Element not found${error.selector ? `: ${error.selector}` : ""}`;
    case "StaleReference":
      return `Stale reference ${error.ref} (${error.reason})`;
    case "Timeout":
      return `Timeout: ${error.operation}`;
    case "CommandFailed":
      return `Command failed: ${error.message}`;
    case "ValidationFailed":
      return `Validation failed: ${error.message}`;
  }
  return exhaustive(error);
}

function wireFailure(error: ControllerError, stage: CleanupStage = "command"): WireFailure {
  switch (error._tag) {
    case "SessionNotFound":
    case "SessionExpired":
    case "ElementNotFound":
    case "StaleReference":
      return { errorType: "target_not_found" };
    case "ProfileUnavailable":
      return { errorType: "invalid_value" };
    case "SessionNotReady":
      return { errorType: "command_failed", cause: "container_creation" };
    case "ContainerCreateFailed":
    case "ProfileCopyFailed":
      return {
        errorType: "command_failed",
        cause: stage === "cleanup" ? "cleanup" : "container_creation",
      };
    case "CdpUnreachable":
    case "CdpDisconnected":

    case "Timeout":
    case "CommandFailed":
    case "ValidationFailed":
      return { errorType: "command_failed", cause: stage === "cleanup" ? "cleanup" : "cdp" };
  }
  return exhaustive(error);
}

// The response type itself carries the error-type/cause invariant; callers spread
// `wireFailure` directly so adding a ControllerError variant fails every mapping
// site at compile time.

function errorToWireResponse(
  sessionId: string,
  error: ControllerError,
  stage: CleanupStage = "command",
): WireResponse {
  return {
    type: "command_result",
    sessionId,
    success: false,
    error: formatError(error),
    code: ErrorCode[error._tag],
    ...wireFailure(error, stage),
  };
}

// ─── activity logging ───

type SessionActivityLog =
  | { readonly _tag: "Register"; readonly sessionId: string; readonly profile: string }
  | { readonly _tag: "Command"; readonly sessionId: string; readonly action: BrowserCommand["action"] }
  | { readonly _tag: "Deregister"; readonly sessionId: string }
  | { readonly _tag: "Expired"; readonly sessionId: string; readonly reason: string }
  | { readonly _tag: "CdpDisconnect"; readonly sessionId: string };

function logSessionActivity(event: SessionActivityLog): void {
  const timestamp = new Date().toISOString();

  switch (event._tag) {
    case "Register":
      console.log(`${timestamp} [register] session=${event.sessionId} profile=${event.profile}`);
      return;
    case "Command":
      console.log(`${timestamp} [command] session=${event.sessionId} action=${event.action}`);
      return;
    case "Deregister":
      console.log(`${timestamp} [deregister] session=${event.sessionId}`);
      return;
    case "Expired":
      console.log(`${timestamp} [expired] session=${event.sessionId} reason=${event.reason}`);
      return;
    case "CdpDisconnect":
      console.log(`${timestamp} [cdp-disconnect] session=${event.sessionId}`);
      return;
    default:
      exhaustive(event);
  }
}
type CleanupTrigger = "deregister" | "idle-expired" | "cdp-disconnect";

type CleanupRecord = {
  readonly operationId: string;
  readonly trigger: CleanupTrigger;
  readonly owner: string;
  readonly containerId: string | undefined;
  readonly promise: Promise<ContainerResult<void, ControllerError>>;
};

// ─── WsHandler ───

export type WsHandlerDeps = {
  readonly registry: SessionRegistry;
  readonly containerManager: ContainerManager;
  readonly refStore: RefStore;
  readonly config: ControllerConfig;
  readonly connectCDP?: typeof connectCDP;
  readonly executeCommand?: typeof executeCommand;
};

export type WsHandler = {
  handleConnection(ws: WebSocket): void;
  onSessionExpired(sessionId: string, reason: string): void;
};

export function createWsHandler(deps: WsHandlerDeps): WsHandler {
  const {
    registry,
    containerManager,
    refStore,
    config,
    connectCDP: connectCdp = connectCDP,
    executeCommand: runCommand = executeCommand,
  } = deps;

  // Persistent CDP connection cache — survives ws close, keyed by sessionId
  const cdpCache = new Map<string, CdpConnection>();

  const sessionContainers = new Map<string, string>();
  const cleanupRecords = new Map<string, CleanupRecord>();

  function requestCleanup(
    sessionId: string,
    trigger: CleanupTrigger,
    containerIdHint?: string,
  ): Promise<ContainerResult<void, ControllerError>> {
    const existing = cleanupRecords.get(sessionId);
    if (existing) {
      console.log(
        `[cleanup-join] owner=${existing.owner} session=${sessionId} container=${
          existing.containerId ?? "unknown"
        } operation=${existing.operationId} trigger=${trigger} primary=${existing.trigger}`,
      );
      return existing.promise;
    }

    const operationId = randomBytes(8).toString("hex");
    const containerId = containerIdHint ?? sessionContainers.get(sessionId);
    let resolvePromise: ((result: ContainerResult<void, ControllerError>) => void) | undefined;
    const promise = new Promise<ContainerResult<void, ControllerError>>((resolve) => {
      resolvePromise = resolve;
    });
    const record: CleanupRecord = {
      operationId,
      trigger,
      owner: config.controllerOwner,
      containerId,
      promise,
    };
    cleanupRecords.set(sessionId, record);

    void performCleanup(sessionId, record).then((result) => {
      if (result._tag === "Err") {
        cleanupRecords.delete(sessionId);
      }
      resolvePromise?.(result);
    });
    return promise;
  }

  async function performCleanup(
    sessionId: string,
    record: CleanupRecord,
  ): Promise<ContainerResult<void, ControllerError>> {
    console.log(
      `[cleanup-start] owner=${record.owner} session=${sessionId} container=${
        record.containerId ?? "unknown"
      } operation=${record.operationId} trigger=${record.trigger}`,
    );

    let closeFailure: ControllerError | undefined;
    const cdp = cdpCache.get(sessionId);
    if (cdp && record.trigger !== "cdp-disconnect") {
      try {
        await cdp.browser.close();
      } catch (error) {
        closeFailure = {
          _tag: "CommandFailed",
          message: `CDP close failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    let destroyResult: ContainerResult<void, ControllerError>;
    try {
      destroyResult = await containerManager.destroy(sessionId);
    } catch (error) {
      destroyResult = {
        _tag: "Err",
        error: {
          _tag: "ContainerCreateFailed",
          message: `Container destroy threw: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }

    cdpCache.delete(sessionId);
    clearSessionRuntimeState(sessionId);
    refStore.clear(sessionId);

    let result: ContainerResult<void, ControllerError> = destroyResult;
    if (destroyResult._tag === "Ok" && closeFailure) {
      result = { _tag: "Err", error: closeFailure };
    }
    let failureDetails = "";
    if (result._tag === "Ok") {
      sessionContainers.delete(sessionId);
    } else {
      const failure = wireFailure(result.error, "cleanup");
      failureDetails = ` error=${formatError(result.error)} errorType=${failure.errorType}${
        failure.errorType === "command_failed" ? ` cause=${failure.cause}` : ""
      }`;
    }
    console.log(
      `[cleanup-result] owner=${record.owner} session=${sessionId} container=${
        record.containerId ?? "unknown"
      } operation=${record.operationId} trigger=${record.trigger} outcome=${
        result._tag === "Ok" ? "success" : "failed"
      }${failureDetails}`,
    );
    return result;
  }
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
    // Resolve and preflight the configured source before allocating a session.
    const profileResult = await resolveProfilePath(profile, config);
    if (profileResult._tag === "Err") {
      return {
        type: "register_result",
        success: false,
        error: formatError(profileResult.error),
        code: ErrorCode[profileResult.error._tag],
        ...wireFailure(profileResult.error),
      };
    }
    const profilePath = profileResult.value;

    // SessionRegistry.register() is the first mutating step.
    const regResult = registry.register(profile);
    if (regResult._tag === "Err") {
      return {
        type: "register_result",
        success: false,
        error: formatError(regResult.error),
        code: ErrorCode[regResult.error._tag],
        ...wireFailure(regResult.error),
      };
    }
    const sessionId = regResult.value;

    // ContainerManager.create() — transition through states
    registry.transition(sessionId, { _tag: "CreatingContainer", profilePath });

    const containerResult = await containerManager.create(sessionId, profilePath);
    if (containerResult._tag === "Err") {
      // Rollback without scheduling a second cleanup attempt.
      registry.deregister(sessionId, false);
      return {
        type: "register_result",
        success: false,
        error: formatError(containerResult.error),
        code: ErrorCode[containerResult.error._tag],
        ...wireFailure(containerResult.error),
      };
    }

    const { containerId, ip } = containerResult.value;
    sessionContainers.set(sessionId, containerId);
    registry.transition(sessionId, { _tag: "ConnectingCDP", containerId });


    // Step 3: CdpBridge.connect()
    let cdp: CdpConnection;
    try {
      cdp = await connectCdp(`http://${ip}:9222`);
    } catch (e) {
      // Rollback: destroy container + deregister without invoking cleanup hooks.
      const destroyResult = await containerManager.destroy(sessionId);
      if (destroyResult._tag === "Err") {
        console.warn(
          `[cleanup-result] owner=${config.controllerOwner} session=${sessionId} container=${containerId} operation=register-rollback trigger=register outcome=failed error=${formatError(
            destroyResult.error,
          )}`,
        );
      }
      registry.deregister(sessionId, false);
      const cdpError: ControllerError = {
        _tag: "CdpUnreachable",
        containerId,
      };
      return {
        type: "register_result",
        success: false,
        error: `CDP connection failed: ${e instanceof Error ? e.message : String(e)}`,
        code: ErrorCode.CdpUnreachable,
        ...wireFailure(cdpError),
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
    logSessionActivity({ _tag: "Register", sessionId, profile: profile ?? "default" });

    return { type: "register_result", success: true, sessionId };
  }

  // ─── command (stateless — looks up CDP from cache) ───

  async function handleCommand(
    sessionId: string,
    command: Parameters<typeof executeCommand>[1],
  ): Promise<WireResponse> {
    logSessionActivity({ _tag: "Command", sessionId, action: command.action });

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

    const result = await runCommand(cdp.context, command, refStore, sessionId);
    if (result._tag === "Err") {
      return errorToWireResponse(sessionId, result.error);
    }

    // §5.6: Attach ContentBoundary for commands that return page content
    const needsBoundary =
      result.value._tag === "SnapshotResult" ||
      result.value._tag === "ScreenshotResult" ||
      result.value._tag === "EvalResult";

    const boundary: ContentBoundary | undefined = needsBoundary
      ? { nonce: randomBytes(16).toString("hex"), origin: activeResult.value.cdpUrl }
      : undefined;

    return {
      type: "command_result",
      sessionId,
      success: true,
      data: result.value,
      ...(boundary ? { boundary } : {}),
    };
  }

  function deregisterErrorResponse(
    sessionId: string,
    error: ControllerError,
    stage: CleanupStage = "command",
  ): WireResponse {
    return {
      type: "deregister_result",
      sessionId,
      success: false,
      error: formatError(error),
      code: ErrorCode[error._tag],
      ...wireFailure(error, stage),
    };
  }

  async function handleDeregister(
    sessionId: string,
  ): Promise<WireResponse> {
    const state = registry.get(sessionId);
    if (!state) {
      return deregisterErrorResponse(sessionId, { _tag: "SessionNotFound", sessionId });
    }

    const containerId = state._tag === "Active"
      ? state.containerId
      : sessionContainers.get(sessionId);
    const cleanup = requestCleanup(sessionId, "deregister", containerId);
    const deregResult = registry.deregister(sessionId);
    if (deregResult._tag === "Err") {
      return deregisterErrorResponse(sessionId, deregResult.error);
    }

    const cleanupResult = await cleanup;
    logSessionActivity({ _tag: "Deregister", sessionId });
    if (cleanupResult._tag === "Err") {
      return deregisterErrorResponse(sessionId, cleanupResult.error, "cleanup");
    }
    return { type: "deregister_result", sessionId, success: true };
  }

  // ─── Browser disconnected handler (§11.3) ───

  function setupBrowserDisconnectHandler(browser: Browser, sessionId: string): void {
    browser.on("disconnected", () => {
      logSessionActivity({ _tag: "CdpDisconnect", sessionId });

      const state = registry.get(sessionId);
      if (state && state._tag !== "Expired") {
        registry.transition(sessionId, {
          _tag: "Expired",
          reason: "CDP disconnected",
        });
      }

      const containerId = state?._tag === "Active"
        ? state.containerId
        : sessionContainers.get(sessionId);
      void requestCleanup(sessionId, "cdp-disconnect", containerId);
    });
  }

  // ─── onSessionExpired (called by idle scanner or explicit deregister) ───

  function onSessionExpired(sessionId: string, reason: string): void {
    logSessionActivity({ _tag: "Expired", sessionId, reason });
    const trigger: CleanupTrigger = reason === "deregistered" ? "deregister" : "idle-expired";
    void requestCleanup(sessionId, trigger, sessionContainers.get(sessionId));
  }
}
