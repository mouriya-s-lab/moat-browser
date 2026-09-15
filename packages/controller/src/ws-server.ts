import type { WebSocket } from "ws";
import type { Browser } from "patchright";
import { randomBytes } from "node:crypto";
import {
  type BrowserCommand,
  type CommandResultData,
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
import {
  createSessionAdmission,
  type AdmissionPhase,
  type SessionAdmission,
} from "./session-admission.js";
import type { SessionRegistry } from "./session-registry.js";
import type { RefStore } from "./ref-store.js";
import {
  clearSessionRuntimeState,
  connectCDP,
  executeCommand,
  type CdpConnection,
  type CommandExecutionOptions,
} from "./cdp-bridge.js";
import type { ControllerConfig } from "./index.js";

// ─── errorToWireResponse (§11.2) ───

type CleanupStage = "command" | "cleanup";

const DEFAULT_COMMAND_TIMEOUT_MS = 25_000;
const REGISTER_TIMEOUT_MS = 45_000;
const EXPLICIT_TIMEOUT_MIN_MS = 1;
const EXPLICIT_TIMEOUT_MAX_MS = 120_000;

function timeoutFailure(
  phase: string,
  budget: number,
  sessionId?: string,
): Extract<ControllerError, { readonly _tag: "Timeout" }> {
  return {
    _tag: "Timeout",
    operation: `${phase} exceeded ${budget}ms${sessionId === undefined ? "" : ` session=${sessionId}`} (result may include partial side effects)`,
  };
}

function terminatedTimeoutFailure(
  phase: string,
  budget: number,
  sessionId: string,
): ControllerError {
  const error = timeoutFailure(phase, budget, sessionId);
  return {
    ...error,
    operation: `${error.operation}; session terminated after outer deadline`,
  };
}


function configuredCommandTimeout(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_COMMAND_TIMEOUT_MS;
}

function commandRequestedTimeout(command: BrowserCommand): number | undefined {
  if (
    command.action === "wait"
    || command.action === "waitforurl"
    || command.action === "waitforloadstate"
    || command.action === "waitforfunction"
    || command.action === "waitfordownload"
  ) {
    return command.timeout;
  }
  return undefined;
}

function commandBudget(
  command: BrowserCommand,
  configuredTimeout: number,
): ContainerResult<number, ControllerError> {
  const requested = commandRequestedTimeout(command);
  if (requested === undefined) {
    return { _tag: "Ok", value: configuredCommandTimeout(configuredTimeout) };
  }
  if (
    !Number.isFinite(requested)
    || !Number.isInteger(requested)
    || requested < EXPLICIT_TIMEOUT_MIN_MS
    || requested > EXPLICIT_TIMEOUT_MAX_MS
  ) {
    return {
      _tag: "Err",
      error: {
        _tag: "ValidationFailed",
        message: `Timeout must be an integer between ${EXPLICIT_TIMEOUT_MIN_MS} and ${EXPLICIT_TIMEOUT_MAX_MS}ms`,
      },
    };
  }
  return { _tag: "Ok", value: requested };
}

function withDeadline<T>(
  start: () => Promise<T>,
  deadline: number,
  onTimeout: () => T,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(onTimeout());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (result: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(onTimeout()), remaining);
    let operation: Promise<T>;
    try {
      operation = start();
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    operation.then(finish, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

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
    case "DialogPending":
      if (error.operationId !== undefined) {
        return `Dialog pending on ${error.page.pageId}: operation ${error.operationId}, dialog ${error.dialogId}; handle it with dialog accept or dismiss`;
      }
      return `Dialog pending on ${error.page.pageId}: dialog ${error.dialogId}; handle it with dialog accept or dismiss`;
    case "CommandFailedWithValue":
      return `Command failed: ${error.message}`;
    case "ValidationFailed":
      return `Validation failed: ${error.message}`;
    case "CapacityExceeded":
      return `Capacity exceeded: ${error.current}/${error.limit} sessions allocated (owner ${error.owner}: ${error.ownerCurrent}/${error.ownerLimit}); ${error.retryCondition}`;
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
    case "ValidationFailed":
      return { errorType: "invalid_value" };
    case "Timeout":
      return { errorType: "timeout" };
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
    case "CommandFailed":
    case "CommandFailedWithValue":
      return { errorType: "command_failed", cause: stage === "cleanup" ? "cleanup" : "cdp" };
    case "DialogPending":
      return {
        errorType: "command_failed",
        cause: "dialog_pending",
        operationId: error.operationId,
        dialogId: error.dialogId,
        page: error.page,
      };
    case "CapacityExceeded":
      return {
        errorType: "capacity_exceeded",
        owner: error.owner,
        current: error.current,
        limit: error.limit,
        ownerCurrent: error.ownerCurrent,
        ownerLimit: error.ownerLimit,
        retryCondition: error.retryCondition,
      };
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
  const details = error._tag === "CommandFailedWithValue"
    ? { details: { _tag: "ThrownValue" as const, value: error.value } }
    : {};
  return {
    type: "command_result",
    sessionId,
    success: false,
    error: formatError(error),
    code: ErrorCode[error._tag],
    ...wireFailure(error, stage),
    ...details,
  };
}

function errorToRegisterResponse(error: ControllerError): WireResponse {
  return {
    type: "register_result",
    success: false,
    error: formatError(error),
    code: ErrorCode[error._tag],
    ...wireFailure(error),
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
  readonly admission?: SessionAdmission;
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
    admission: configuredAdmission,
    containerManager,
    refStore,
    config,
    connectCDP: connectCdp = connectCDP,
    executeCommand: runCommand = executeCommand,
  } = deps;
  const admission =
    configuredAdmission ??
    createSessionAdmission({
      owner: config.controllerOwner,
      ownerQuota: 5,
      totalQuota: 5,
      pendingReservationGraceMs: config.cdpReadyTimeout * 2,
    });

  // Persistent CDP connection cache — survives ws close, keyed by sessionId
  const cdpCache = new Map<string, CdpConnection>();

  const sessionContainers = new Map<string, string>();
  const cleanupRecords = new Map<string, CleanupRecord>();
  // A timed-out register can settle through several late callbacks. Keep one
  // cleanup owner per session so one reservation is released exactly once.
  const registrationCleanupStarted = new Set<string>();
  const admissionReleaseOperations = new Map<string, Promise<ControllerError | undefined>>();
  const releasedAdmissions = new Set<string>();

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
    await updateAdmissionPhase(sessionId, "cleanup");

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
    const releaseError = await releaseAfterCleanup(sessionId, destroyResult);
    if (releaseError && result._tag === "Ok") {
      result = { _tag: "Err", error: releaseError };
    }
    if (destroyResult._tag === "Ok" && !releaseError) {
      sessionContainers.delete(sessionId);
    }
    let failureDetails = "";
    if (result._tag === "Err") {
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
            const response = await handleRegister(parsed.profile, Date.now() + REGISTER_TIMEOUT_MS);
            ws.send(JSON.stringify(response));
            break;
          }

          case "command": {
            const response = await handleCommand(parsed.sessionId, parsed.command);
            ws.send(JSON.stringify(response));
            break;
          }

          case "deregister": {
            const deadline = Date.now() + configuredCommandTimeout(config.commandTimeout);
            const response = await handleDeregister(parsed.sessionId, deadline);
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

  async function updateAdmissionPhase(sessionId: string, phase: AdmissionPhase): Promise<void> {
    const result = await admission.updatePhase(sessionId, phase);
    if (result._tag === "Err") {
      console.warn(
        `[admission-phase-failed] owner=${config.controllerOwner} session=${sessionId} phase=${phase} error=${formatError(
          result.error,
        )}`,
      );
    }
  }

  function releaseAfterCleanup(
    sessionId: string,
    cleanupResult: ContainerResult<void, ControllerError>,
  ): Promise<ControllerError | undefined> {
    const releaseEligible =
      cleanupResult._tag === "Ok"
      || cleanupResult.error._tag === "SessionNotFound";
    return releaseEligible
      ? releaseAdmissionOnce(sessionId)
      : Promise.resolve(undefined);
  }

  function releaseAdmissionOnce(sessionId: string): Promise<ControllerError | undefined> {
    if (releasedAdmissions.has(sessionId)) return Promise.resolve(undefined);
    const existing = admissionReleaseOperations.get(sessionId);
    if (existing) return existing;

    const operation = (async (): Promise<ControllerError | undefined> => {
      try {
        const releaseResult = await admission.release(sessionId);
        if (releaseResult._tag === "Err") {
          console.warn(
            `[admission-release-failed] owner=${config.controllerOwner} session=${sessionId} error=${formatError(
              releaseResult.error,
            )}`,
          );
          return releaseResult.error;
        }
        releasedAdmissions.add(sessionId);
        return undefined;
      } catch (error) {
        const releaseError: ControllerError = {
          _tag: "CommandFailed",
          message: `Admission release threw: ${error instanceof Error ? error.message : String(error)}`,
        };
        console.warn(
          `[admission-release-failed] owner=${config.controllerOwner} session=${sessionId} error=${formatError(
            releaseError,
          )}`,
        );
        return releaseError;
      }
    })();
    admissionReleaseOperations.set(sessionId, operation);
    void operation.then(() => admissionReleaseOperations.delete(sessionId));
    return operation;
  }

  async function destroyForRollback(
    sessionId: string,
  ): Promise<ContainerResult<void, ControllerError>> {
    try {
      return await containerManager.destroy(sessionId);
    } catch (error) {
      return {
        _tag: "Err",
        error: {
          _tag: "CommandFailed",
          message: `Rollback cleanup threw: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  async function cleanupLateRegistration(
    sessionId: string,
    containerId: string | undefined,
    cdp?: CdpConnection,
  ): Promise<void> {
    if (cdp) {
      try {
        await cdp.browser.close();
      } catch (error) {
        console.warn(
          `[cleanup-result] owner=${config.controllerOwner} session=${sessionId} container=${containerId ?? "unknown"} operation=register-timeout trigger=register outcome=failed error=CDP close failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await updateAdmissionPhase(sessionId, "cleanup");
    const destroyResult = await destroyForRollback(sessionId);
    const releaseError = await releaseAfterCleanup(sessionId, destroyResult);
    if (destroyResult._tag === "Ok" && !releaseError) {
      sessionContainers.delete(sessionId);
    }
    if (destroyResult._tag === "Err") {
      console.warn(
        `[cleanup-result] owner=${config.controllerOwner} session=${sessionId} container=${containerId ?? "unknown"} operation=register-timeout trigger=register outcome=failed error=${formatError(
          destroyResult.error,
        )}`,
      );
    }
    if (releaseError) {
      console.warn(
        `[cleanup-result] owner=${config.controllerOwner} session=${sessionId} container=${containerId ?? "unknown"} operation=register-timeout trigger=register outcome=failed error=${formatError(
          releaseError,
        )}`,
      );
    }

    registry.deregister(sessionId, false);
  }
  function startLateRegistrationCleanup(
    sessionId: string,
    containerId: string | undefined,
    cdp: CdpConnection | undefined,
    detail?: string,
  ): void {
    if (registrationCleanupStarted.has(sessionId)) return;
    registrationCleanupStarted.add(sessionId);
    void cleanupLateRegistration(sessionId, containerId, cdp).catch((error) => {
      console.warn(
        `[cleanup-result] owner=${config.controllerOwner} session=${sessionId} container=${containerId ?? "unknown"} operation=register-timeout trigger=register outcome=failed error=${
          error instanceof Error ? error.message : String(error)
        }${detail === undefined ? "" : ` (${detail})`}`,
      );
    });
  }

  function registerTimeoutResponse(phase: string, sessionId?: string): WireResponse {
    const error = timeoutFailure(`register phase=${phase}`, REGISTER_TIMEOUT_MS, sessionId);
    console.warn(
      `[timeout] phase=register/${phase} budget=${REGISTER_TIMEOUT_MS}ms session=${sessionId ?? "pending"} result=unknown`,
    );
    return errorToRegisterResponse(error);
  }
  async function handleRegister(
    profile?: string,
    deadline = Date.now() + REGISTER_TIMEOUT_MS,
  ): Promise<WireResponse> {
    const profileTimeout = timeoutFailure("register phase=profile", REGISTER_TIMEOUT_MS);
    const profileResult = await withDeadline(
      () => resolveProfilePath(profile, config),
      deadline,
      () => ({ _tag: "Err", error: profileTimeout }) as ContainerResult<string, ControllerError>,
    );
    if (profileResult._tag === "Err") {
      return profileResult.error === profileTimeout
        ? registerTimeoutResponse("profile")
        : errorToRegisterResponse(profileResult.error);
    }
    const profilePath = profileResult.value;

    if (deadline <= Date.now()) return registerTimeoutResponse("admission");
    // Reserve before touching Docker. The reservation is shared across
    // controller processes through the admission store and remains occupied
    // until cleanup reaches a terminal state.
    const admissionPromise = admission.reserve();
    const admissionTimeout = timeoutFailure("register phase=admission", REGISTER_TIMEOUT_MS);
    const admissionResult = await withDeadline(
      () => admissionPromise,
      deadline,
      () => ({ _tag: "Err", error: admissionTimeout }) as ContainerResult<
        { readonly sessionId: string },
        ControllerError
      >,
    );
    if (admissionResult._tag === "Err") {
      if (admissionResult.error === admissionTimeout) {
        void admissionPromise.then(
          (lateResult) => {
            switch (lateResult._tag) {
              case "Ok":
                void releaseAdmissionOnce(lateResult.value.sessionId);
                return;
              case "Err":
                return;
            }
            exhaustive(lateResult);
          },
          (error) => console.warn(
            `[admission-release-failed] owner=${config.controllerOwner} session=pending error=${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
        return registerTimeoutResponse("admission");
      }
      if (admissionResult.error._tag === "CapacityExceeded") {
        console.warn(
          `[capacity-rejected] owner=${admissionResult.error.owner} current=${admissionResult.error.current}/${admissionResult.error.limit} ownerCurrent=${admissionResult.error.ownerCurrent}/${admissionResult.error.ownerLimit}`,
        );
      }
      return errorToRegisterResponse(admissionResult.error);
    }
    const sessionId = admissionResult.value.sessionId;

    const regResult = registry.register(profile, sessionId);
    if (regResult._tag === "Err") {
      await releaseAdmissionOnce(sessionId);
      return errorToRegisterResponse(regResult.error);
    }

    // ContainerManager.create() — transition through states
    registry.transition(sessionId, { _tag: "CreatingContainer", profilePath });
    await updateAdmissionPhase(sessionId, "creating");

    const containerPromise = containerManager.create(sessionId, profilePath);
    const containerTimeout = timeoutFailure("register phase=container_creation", REGISTER_TIMEOUT_MS, sessionId);
    const containerResult = await withDeadline(
      () => containerPromise,
      deadline,
      () => ({ _tag: "Err", error: containerTimeout }) as ContainerResult<
        { readonly containerId: string; readonly ip: string; readonly cdpPort: number },
        ControllerError
      >,
    );
    if (containerResult._tag === "Err") {
      if (containerResult.error === containerTimeout) {
        void updateAdmissionPhase(sessionId, "cleanup");
        registry.deregister(sessionId, false);
        void containerPromise.then(
          (lateResult) => {
            switch (lateResult._tag) {
              case "Ok":
                startLateRegistrationCleanup(sessionId, lateResult.value.containerId, undefined);
                return;
              case "Err":
                startLateRegistrationCleanup(sessionId, sessionContainers.get(sessionId), undefined);
                return;
            }
            exhaustive(lateResult);
          },
          (error) => {
            startLateRegistrationCleanup(
              sessionId,
              sessionContainers.get(sessionId),
              undefined,
              `create rejected: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        );
        return registerTimeoutResponse("container_creation", sessionId);
      }
      const destroyResult = await destroyForRollback(sessionId);
      await releaseAfterCleanup(sessionId, destroyResult);
      registry.deregister(sessionId, false);
      return errorToRegisterResponse(containerResult.error);
    }

    const { containerId, ip } = containerResult.value;
    sessionContainers.set(sessionId, containerId);
    if (deadline <= Date.now()) {
      registry.deregister(sessionId, false);
      startLateRegistrationCleanup(sessionId, containerId, undefined);
      return registerTimeoutResponse("container_creation", sessionId);
    }
    registry.transition(sessionId, { _tag: "ConnectingCDP", containerId });
    await updateAdmissionPhase(sessionId, "connecting");

    // Step 3: CdpBridge.connect()
    const cdpPromise = connectCdp(`http://${ip}:9222`);
    let cdp: CdpConnection | null;
    try {
      cdp = await withDeadline(
        () => cdpPromise,
        deadline,
        () => null,
      );
    } catch (e) {
      // Rollback: destroy container + deregister without invoking cleanup hooks.
      const destroyResult = await destroyForRollback(sessionId);
      await releaseAfterCleanup(sessionId, destroyResult);
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
    if (cdp === null) {
      registry.deregister(sessionId, false);
      void cdpPromise.then(
        (lateCdp) => startLateRegistrationCleanup(sessionId, containerId, lateCdp),
        (error) => {
          startLateRegistrationCleanup(
            sessionId,
            containerId,
            undefined,
            `CDP rejected: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
      return registerTimeoutResponse("cdp", sessionId);
    }
    if (deadline <= Date.now()) {
      registry.deregister(sessionId, false);
      startLateRegistrationCleanup(sessionId, containerId, cdp);
      return registerTimeoutResponse("cdp", sessionId);
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
    await updateAdmissionPhase(sessionId, "active");

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

    const budgetResult = commandBudget(command, config.commandTimeout);
    if (budgetResult._tag === "Err") {
      return errorToWireResponse(sessionId, budgetResult.error);
    }
    const budget = budgetResult.value;
    const deadline = Date.now() + budget;

    // close → deregister
    if (command.action === "close") {
      return handleDeregister(sessionId, deadline, budget);
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
    const options: CommandExecutionOptions = { deadline, budget };
    const result = await withDeadline(
      () => runCommand(cdp.context, command, refStore, sessionId, options),
      deadline,
      () => {
        const error = terminatedTimeoutFailure(`command phase=cdp action=${command.action}`, budget, sessionId);
        console.warn(
          `[timeout] phase=command/cdp action=${command.action} budget=${budget}ms session=${sessionId} result=unknown`,
        );
        void cdp.browser.close().catch(() => {});
        return { _tag: "Err", error } as ContainerResult<CommandResultData, ControllerError>;
      },
    );
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
    deadline = Date.now() + configuredCommandTimeout(config.commandTimeout),
    budget = configuredCommandTimeout(config.commandTimeout),
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

    const cleanupTimeout = timeoutFailure("deregister phase=cleanup", budget, sessionId);
    const cleanupResult = await withDeadline(
      () => cleanup,
      deadline,
      () => ({ _tag: "Err", error: cleanupTimeout }) as ContainerResult<void, ControllerError>,
    );
    logSessionActivity({ _tag: "Deregister", sessionId });
    if (cleanupResult._tag === "Err") {
      if (cleanupResult.error === cleanupTimeout) {
        console.warn(
          `[timeout] phase=deregister/cleanup budget=${budget}ms session=${sessionId} result=unknown`,
        );
      }
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
