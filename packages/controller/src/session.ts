import type { SessionState, GatewayError } from "@moat-browser/types";
import { transitionSession } from "@moat-browser/types";
import type { CdpConnection } from "./cdp-bridge";
import type { Config } from "./config";

export interface SessionEntry {
  readonly sessionId: string;
  readonly agentId: string;
  state: SessionState;
  containerId: string | null;
  containerIp: string | null;
  cdpConnection: CdpConnection | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly agentToSession = new Map<string, string>();

  getBySessionId(sessionId: string): SessionEntry | GatewayError {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return { _tag: "SessionNotFound", sessionId };
    }
    if (entry.state._tag === "Expired") {
      return { _tag: "SessionExpired", sessionId };
    }
    return entry;
  }

  getByAgentId(agentId: string): SessionEntry | undefined {
    const sessionId = this.agentToSession.get(agentId);
    if (!sessionId) return undefined;
    return this.sessions.get(sessionId);
  }

  create(agentId: string): SessionEntry {
    const sessionId = crypto.randomUUID();
    const entry: SessionEntry = {
      sessionId,
      agentId,
      state: { _tag: "Registering" },
      containerId: null,
      containerIp: null,
      cdpConnection: null,
      idleTimer: null,
      reconnectTimer: null,
    };
    this.sessions.set(sessionId, entry);
    this.agentToSession.set(agentId, sessionId);
    return entry;
  }

  transition(
    sessionId: string,
    event: Parameters<typeof transitionSession>[1]
  ): SessionState | GatewayError {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return { _tag: "SessionNotFound", sessionId };
    }

    const result = transitionSession(entry.state, event);
    if (result._tag === "InvalidTransition") {
      return {
        _tag: "SessionExpired",
        sessionId,
      };
    }

    entry.state = result.state;
    return result.state;
  }

  remove(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      this.agentToSession.delete(entry.agentId);
      this.sessions.delete(sessionId);
    }
  }

  startIdleTimer(sessionId: string, config: Config, onExpired: () => void): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      this.transition(sessionId, { _tag: "IdleTimeout" });
      onExpired();
    }, config.idleTimeoutMs);
  }

  resetIdleTimer(sessionId: string, config: Config, onExpired: () => void): void {
    this.startIdleTimer(sessionId, config, onExpired);
  }

  startReconnectTimer(sessionId: string, config: Config, onExpired: () => void): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = setTimeout(() => {
      this.transition(sessionId, { _tag: "ReconnectTimeout" });
      onExpired();
    }, config.reconnectTimeoutMs);
  }

  clearReconnectTimer(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
  }

  allSessions(): ReadonlyArray<SessionEntry> {
    return Array.from(this.sessions.values());
  }
}
