import { config } from "./config.js";

export type Session = {
  sessionId: string;
  agentId: string;
  profileName: string;
  containerId: string;
  socketPath: string;
  socketId: string; // Socket.IO socket id
  createdAt: number;
  expiresAt: number;
  disconnectTimer?: ReturnType<typeof setTimeout>;
};

const sessions = new Map<string, Session>();
const agentToSession = new Map<string, string>(); // agentId → sessionId

function generateSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createSession(
  agentId: string,
  profileName: string,
  containerId: string,
  socketPath: string,
  socketId: string,
): Session {
  const sessionId = generateSessionId();
  const now = Date.now();
  const session: Session = {
    sessionId,
    agentId,
    profileName,
    containerId,
    socketPath,
    socketId,
    createdAt: now,
    expiresAt: now + config.sessionTimeoutMs,
  };

  sessions.set(sessionId, session);
  agentToSession.set(agentId, sessionId);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function getSessionByAgent(agentId: string): Session | undefined {
  const sessionId = agentToSession.get(agentId);
  return sessionId ? sessions.get(sessionId) : undefined;
}

export function removeSession(sessionId: string): Session | undefined {
  const session = sessions.get(sessionId);
  if (session) {
    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    sessions.delete(sessionId);
    agentToSession.delete(session.agentId);
  }
  return session;
}

export function removeSessionsBySocketId(socketId: string): Session[] {
  const removed: Session[] = [];
  for (const [id, session] of sessions) {
    if (session.socketId === socketId) {
      sessions.delete(id);
      agentToSession.delete(session.agentId);
      removed.push(session);
    }
  }
  return removed;
}

export function isExpired(session: Session): boolean {
  return Date.now() > session.expiresAt;
}

export function allSessions(): Session[] {
  return Array.from(sessions.values());
}
