/**
 * session-registry.ts — In-memory Session Registry
 *
 * Manages all active sessions keyed by sessionId.
 * Drives state machine transitions via SessionEvent.
 */

import { randomUUID } from "crypto";
import type { SessionState, SessionEvent } from "@moat-browser/types";
import { transitionSession } from "@moat-browser/types";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// SessionRegistry
// ---------------------------------------------------------------------------

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionState>();

  /** Register a new session for an agent. Returns the initial state. */
  create(agentId: string): { sessionId: string; state: SessionState } {
    const sessionId = randomUUID();
    const state: SessionState = { _tag: "Registering", agentId };
    // Store with sessionId for later lookup; initial state doesn't have sessionId
    // We need to track agentId → sessionId mapping for lookup
    this.sessions.set(sessionId, state);
    this._agentToSession.set(agentId, sessionId);
    return { sessionId, state };
  }

  /** Lookup session by sessionId. */
  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /** Lookup sessionId by agentId. */
  getSessionIdByAgent(agentId: string): string | undefined {
    return this._agentToSession.get(agentId);
  }

  /** Apply an event to a session, returning the new state. */
  dispatch(sessionId: string, event: SessionEvent): SessionState | undefined {
    const current = this.sessions.get(sessionId);
    if (current === undefined) return undefined;

    const next = transitionSession(current, event);
    this.sessions.set(sessionId, next);

    // If destroyed, clean up mappings
    if (next._tag === "Destroyed") {
      this._agentToSession.delete(next.agentId);
    }

    return next;
  }

  /** Remove a session entirely. */
  delete(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state !== undefined) {
      this._agentToSession.delete(state.agentId);
    }
    this.sessions.delete(sessionId);
  }

  /** Return all sessions (snapshot). */
  all(): ReadonlyMap<string, SessionState> {
    return this.sessions;
  }

  /** Return sessions in Expired or Reconnecting state past deadline. */
  stale(now: number): Array<{ sessionId: string; state: SessionState }> {
    const result: Array<{ sessionId: string; state: SessionState }> = [];
    for (const [sessionId, state] of this.sessions) {
      if (state._tag === "Expired") {
        result.push({ sessionId, state });
      } else if (
        state._tag === "Reconnecting" &&
        now >= state.reconnectDeadline
      ) {
        result.push({ sessionId, state });
      } else if (
        state._tag === "Active" &&
        now - state.lastActivityAt > config.sessionIdleTimeoutMs
      ) {
        result.push({ sessionId, state });
      }
    }
    return result;
  }

  private readonly _agentToSession = new Map<string, string>();
}
