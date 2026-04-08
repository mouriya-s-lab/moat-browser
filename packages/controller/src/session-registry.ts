import { randomUUID } from "node:crypto";
import type { ControllerError, SessionState } from "@moat-browser/types";

// ─── Result ADT ───

export type Result<T, E> =
  | { readonly _tag: "Ok"; readonly value: T }
  | { readonly _tag: "Err"; readonly error: E };

function Ok<T>(value: T): Result<T, never> {
  return { _tag: "Ok", value };
}

function Err<E>(error: E): Result<never, E> {
  return { _tag: "Err", error };
}

// ─── ActiveSession ───

export type ActiveSession = Extract<SessionState, { readonly _tag: "Active" }>;

// ─── Config ───

export type SessionRegistryConfig = {
  readonly sessionIdleTimeout: number; // ms, default 600_000 (10 min)
  readonly reconnectTimeout: number;   // ms, default 5_000 (5s)
  readonly scanInterval: number;       // ms, default 30_000 (30s)
};

const defaultConfig: SessionRegistryConfig = {
  sessionIdleTimeout: 600_000,
  reconnectTimeout: 5_000,
  scanInterval: 30_000,
};

// ─── SessionEntry ───

type SessionEntry = {
  readonly sessionId: string;
  state: SessionState;
  readonly profile: string | undefined;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
};

// ─── SessionRegistry ───

export type SessionRegistry = {
  register(profile?: string): Result<string, ControllerError>;
  transition(sessionId: string, newState: SessionState): Result<void, ControllerError>;
  resume(sessionId: string): Result<void, ControllerError>;
  deregister(sessionId: string): Result<void, ControllerError>;
  get(sessionId: string): SessionState | undefined;
  getActive(sessionId: string): Result<ActiveSession, ControllerError>;
  markDisconnected(sessionId: string): Result<void, ControllerError>;
  touchActivity(sessionId: string): void;
  dispose(): void;
};

export function createSessionRegistry(
  config: Partial<SessionRegistryConfig> = {},
  onExpired?: (sessionId: string, reason: string) => void,
): SessionRegistry {
  const cfg: SessionRegistryConfig = { ...defaultConfig, ...config };
  const entries = new Map<string, SessionEntry>();

  // Idle timeout scanner
  const idleTimer = setInterval(scanIdle, cfg.scanInterval);

  return {
    register,
    transition,
    resume,
    deregister,
    get,
    getActive,
    markDisconnected,
    touchActivity,
    dispose,
  };

  function register(profile?: string): Result<string, ControllerError> {
    const sessionId = randomUUID();
    const entry: SessionEntry = {
      sessionId,
      state: { _tag: "Registering" },
      profile,
      reconnectTimer: undefined,
    };
    entries.set(sessionId, entry);
    return Ok(sessionId);
  }

  function transition(
    sessionId: string,
    newState: SessionState,
  ): Result<void, ControllerError> {
    const entry = entries.get(sessionId);
    if (!entry) {
      return Err({ _tag: "SessionNotFound", sessionId });
    }
    if (entry.state._tag === "Expired") {
      return Err({ _tag: "SessionExpired", sessionId, reason: entry.state.reason });
    }
    entry.state = newState;
    return Ok(undefined);
  }

  function resume(sessionId: string): Result<void, ControllerError> {
    const entry = entries.get(sessionId);
    if (!entry) {
      return Err({ _tag: "SessionNotFound", sessionId });
    }
    if (entry.state._tag !== "Reconnecting") {
      if (entry.state._tag === "Expired") {
        return Err({ _tag: "SessionExpired", sessionId, reason: entry.state.reason });
      }
      return Err({
        _tag: "SessionNotReady",
        sessionId,
        state: entry.state._tag,
      });
    }
    // Clear reconnect timer
    if (entry.reconnectTimer !== undefined) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = undefined;
    }
    // Restore Active state — containerId preserved from Reconnecting
    const now = Date.now();
    entry.state = {
      _tag: "Active",
      containerId: entry.state.containerId,
      containerIp: "",  // ws-server will re-fill via transition if needed
      cdpUrl: "",
      createdAt: now,
      lastActivity: now,
    };
    return Ok(undefined);
  }

  function deregister(sessionId: string): Result<void, ControllerError> {
    const entry = entries.get(sessionId);
    if (!entry) {
      return Err({ _tag: "SessionNotFound", sessionId });
    }
    // Clear reconnect timer if any
    if (entry.reconnectTimer !== undefined) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = undefined;
    }
    entry.state = { _tag: "Expired", reason: "deregistered" };
    onExpired?.(sessionId, "deregistered");
    return Ok(undefined);
  }

  function get(sessionId: string): SessionState | undefined {
    return entries.get(sessionId)?.state;
  }

  function getActive(sessionId: string): Result<ActiveSession, ControllerError> {
    const entry = entries.get(sessionId);
    if (!entry) {
      return Err({ _tag: "SessionNotFound", sessionId });
    }
    if (entry.state._tag === "Expired") {
      return Err({ _tag: "SessionExpired", sessionId, reason: entry.state.reason });
    }
    if (entry.state._tag !== "Active") {
      return Err({ _tag: "SessionNotReady", sessionId, state: entry.state._tag });
    }
    return Ok(entry.state);
  }

  function markDisconnected(sessionId: string): Result<void, ControllerError> {
    const entry = entries.get(sessionId);
    if (!entry) {
      return Err({ _tag: "SessionNotFound", sessionId });
    }
    if (entry.state._tag !== "Active") {
      return Err({ _tag: "SessionNotReady", sessionId, state: entry.state._tag });
    }
    const containerId = entry.state.containerId;
    entry.state = { _tag: "Reconnecting", since: Date.now(), containerId };

    // Start reconnect timeout
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      if (entry.state._tag === "Reconnecting") {
        entry.state = { _tag: "Expired", reason: "reconnect timeout" };
        onExpired?.(sessionId, "reconnect timeout");
      }
    }, cfg.reconnectTimeout);

    return Ok(undefined);
  }

  function touchActivity(sessionId: string): void {
    const entry = entries.get(sessionId);
    if (entry && entry.state._tag === "Active") {
      entry.state = { ...entry.state, lastActivity: Date.now() };
    }
  }

  function scanIdle(): void {
    const now = Date.now();
    for (const [sessionId, entry] of entries) {
      if (
        entry.state._tag === "Active" &&
        now - entry.state.lastActivity > cfg.sessionIdleTimeout
      ) {
        entry.state = { _tag: "Expired", reason: "idle timeout" };
        onExpired?.(sessionId, "idle timeout");
      }
    }
  }

  function dispose(): void {
    clearInterval(idleTimer);
    for (const entry of entries.values()) {
      if (entry.reconnectTimer !== undefined) {
        clearTimeout(entry.reconnectTimer);
      }
    }
    entries.clear();
  }
}
