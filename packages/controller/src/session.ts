// Session Registry + state machine integration (design.md §4.4)
import type { SessionState, SessionEvent, TransitionResult } from "@moat-browser/types";
import { transitionSession } from "@moat-browser/types";
import type { CDPConnection } from "./cdp-bridge.js";

// Timers associated with a session lifecycle
interface SessionTimers {
  idleTimer?: ReturnType<typeof setTimeout>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

// Full session entry stored in the registry
export interface SessionEntry {
  state: SessionState;
  conn?: CDPConnection;
  readonly timers: SessionTimers;
}

// In-memory session registry — sessionId → SessionEntry
const registry = new Map<string, SessionEntry>();

// Create a new session entry in Registering state
export function createSession(agentId: string): string {
  const sessionId = crypto.randomUUID();
  registry.set(sessionId, {
    state: { _tag: "Registering", agentId },
    timers: {},
  });
  return sessionId;
}

// Retrieve a session entry
export function getSession(sessionId: string): SessionEntry | undefined {
  return registry.get(sessionId);
}

// Apply an event to a session via the state machine transition function
export function applyEvent(
  sessionId: string,
  event: SessionEvent
): TransitionResult {
  const entry = registry.get(sessionId);
  if (!entry) {
    return {
      ok: false,
      error: { _tag: "SessionNotFound", sessionId },
    };
  }

  const result = transitionSession(entry.state, event);
  if (result.ok) {
    entry.state = result.next;
  }
  return result;
}

// Attach a CDPConnection to a session
export function attachConnection(sessionId: string, conn: CDPConnection): void {
  const entry = registry.get(sessionId);
  if (entry) {
    entry.conn = conn;
  }
}

// Detach the CDPConnection from a session (does not close it)
export function detachConnection(sessionId: string): CDPConnection | undefined {
  const entry = registry.get(sessionId);
  if (!entry) return undefined;
  const conn = entry.conn;
  entry.conn = undefined;
  return conn;
}

// Delete a session entry from the registry (call after Destroyed state)
export function deleteSession(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (entry) {
    clearTimeout(entry.timers.idleTimer);
    clearTimeout(entry.timers.reconnectTimer);
  }
  registry.delete(sessionId);
}

// List all session IDs and their current state tags (for diagnostics)
export function listSessions(): Array<{ sessionId: string; stateTag: string }> {
  return Array.from(registry.entries()).map(([sessionId, entry]) => ({
    sessionId,
    stateTag: entry.state._tag,
  }));
}

// Set (or clear) the idle timer for a session
export function setIdleTimer(
  sessionId: string,
  timeoutMs: number,
  onFire: () => void
): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timers.idleTimer);
  entry.timers.idleTimer = setTimeout(onFire, timeoutMs);
}

// Set (or clear) the reconnect timer for a session
export function setReconnectTimer(
  sessionId: string,
  timeoutMs: number,
  onFire: () => void
): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timers.reconnectTimer);
  entry.timers.reconnectTimer = setTimeout(onFire, timeoutMs);
}

// Clear the idle timer for a session
export function clearIdleTimer(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (entry) {
    clearTimeout(entry.timers.idleTimer);
    entry.timers.idleTimer = undefined;
  }
}
