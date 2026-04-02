import { randomUUID } from "node:crypto";
import type { SessionState, SessionEvent, TransitionError } from "@moat-browser/types";
import { transitionSession } from "@moat-browser/types";

export interface Session {
  readonly id: string;
  readonly agentId: string;
  state: SessionState;
  containerId: string | null;
  containerIp: string | null;
  socketId: string;
  readonly createdAt: number;
  lastActivityAt: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();

  create(agentId: string, socketId: string): Session {
    const id = randomUUID();
    const session: Session = {
      id,
      agentId,
      state: { _tag: "Registering" },
      containerId: null,
      containerIp: null,
      socketId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getBySocketId(socketId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.socketId === socketId) return session;
    }
    return undefined;
  }

  transition(id: string, event: SessionEvent): SessionState | TransitionError {
    const session = this.sessions.get(id);
    if (!session) {
      return {
        _tag: "TransitionError",
        from: "unknown",
        event: event._tag,
        message: `Session ${id} not found`,
      };
    }
    const result = transitionSession(session.state, event);
    if (result._tag !== "TransitionError") {
      session.state = result;
      session.lastActivityAt = Date.now();
    }
    return result;
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  all(): ReadonlyArray<Session> {
    return Array.from(this.sessions.values());
  }
}
