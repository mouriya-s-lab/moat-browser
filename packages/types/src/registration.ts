import { type } from "arktype";
import { exhaustive } from "./exhaustive.js";

// ---- Expire Reason ADT ----

export type ExpireReason =
  | { readonly _tag: "IdleTimeout"; readonly idleDuration: number }
  | { readonly _tag: "TokenExpired" }
  | { readonly _tag: "ReconnectTimeout" }
  | { readonly _tag: "BudgetExhausted"; readonly limit: string }
  | { readonly _tag: "ContainerCrashed"; readonly exitCode: number }
  | { readonly _tag: "ManualDeregister" }
  | { readonly _tag: "ForceReplaced"; readonly newSessionId: string };

// ---- Session State ADT ----

export type SessionState =
  | { readonly _tag: "Registering"; readonly agentId: string; readonly profileName: string }
  | { readonly _tag: "CreatingContainer"; readonly agentId: string; readonly profileName: string }
  | { readonly _tag: "Active"; readonly agentId: string; readonly sessionId: string; readonly containerId: string }
  | { readonly _tag: "Idle"; readonly agentId: string; readonly sessionId: string; readonly idleSince: string }
  | { readonly _tag: "Reconnecting"; readonly agentId: string; readonly sessionId: string; readonly disconnectedAt: string }
  | { readonly _tag: "Expired"; readonly agentId: string; readonly sessionId: string; readonly reason: ExpireReason }
  | { readonly _tag: "Destroyed" };

// ---- Session Event ADT ----

export type SessionEvent =
  | { readonly _tag: "ContainerReady"; readonly containerId: string }
  | { readonly _tag: "CommandReceived" }
  | { readonly _tag: "CommandCompleted" }
  | { readonly _tag: "Disconnected" }
  | { readonly _tag: "Reconnected"; readonly socketId: string }
  | { readonly _tag: "ReconnectTimedOut" }
  | { readonly _tag: "IdleTimedOut"; readonly idleDuration: number }
  | { readonly _tag: "TokenExpired" }
  | { readonly _tag: "BudgetExhausted"; readonly limit: string }
  | { readonly _tag: "ContainerCrashed"; readonly exitCode: number }
  | { readonly _tag: "DeregisterRequested" }
  | { readonly _tag: "ForceReplace"; readonly newSessionId: string };

// ---- State Machine ----

export function transitionSession(
  state: SessionState,
  event: SessionEvent,
): SessionState {
  switch (state._tag) {
    case "Registering":
    case "CreatingContainer":
      switch (event._tag) {
        case "ContainerReady":
          return { _tag: "Active", agentId: state.agentId, sessionId: `sess-${Date.now().toString(36)}`, containerId: event.containerId };
        case "ContainerCrashed":
          return { _tag: "Expired", agentId: state.agentId, sessionId: "", reason: { _tag: "ContainerCrashed", exitCode: event.exitCode } };
        case "DeregisterRequested":
          return { _tag: "Destroyed" };
        default: return state;
      }

    case "Active":
      switch (event._tag) {
        case "CommandReceived": return state;
        case "CommandCompleted": return { _tag: "Idle", agentId: state.agentId, sessionId: state.sessionId, idleSince: new Date().toISOString() };
        case "Disconnected":
          return { _tag: "Reconnecting", agentId: state.agentId, sessionId: state.sessionId, disconnectedAt: new Date().toISOString() };
        case "IdleTimedOut":
          return { _tag: "Expired", agentId: state.agentId, sessionId: state.sessionId, reason: { _tag: "IdleTimeout", idleDuration: event.idleDuration } };
        case "TokenExpired":
          return { _tag: "Expired", agentId: state.agentId, sessionId: state.sessionId, reason: { _tag: "TokenExpired" } };
        case "BudgetExhausted":
          return { _tag: "Expired", agentId: state.agentId, sessionId: state.sessionId, reason: { _tag: "BudgetExhausted", limit: event.limit } };
        case "ContainerCrashed":
          return { _tag: "Expired", agentId: state.agentId, sessionId: state.sessionId, reason: { _tag: "ContainerCrashed", exitCode: event.exitCode } };
        case "DeregisterRequested":
          return { _tag: "Expired", agentId: state.agentId, sessionId: state.sessionId, reason: { _tag: "ManualDeregister" } };
        case "ForceReplace":
          return { _tag: "Expired", agentId: state.agentId, sessionId: state.sessionId, reason: { _tag: "ForceReplaced", newSessionId: event.newSessionId } };
        default: return state;
      }

    case "Idle":
      switch (event._tag) {
        case "CommandReceived":
          return { _tag: "Active", agentId: state.agentId, sessionId: state.sessionId, containerId: "" };
        case "Disconnected":
          return { _tag: "Reconnecting", agentId: state.agentId, sessionId: state.sessionId, disconnectedAt: new Date().toISOString() };
        case "IdleTimedOut":
          return { _tag: "Expired", agentId: state.agentId, sessionId: state.sessionId, reason: { _tag: "IdleTimeout", idleDuration: event.idleDuration } };
        case "TokenExpired":
          return { _tag: "Expired", agentId: state.agentId, sessionId: state.sessionId, reason: { _tag: "TokenExpired" } };
        case "DeregisterRequested":
          return { _tag: "Expired", agentId: state.agentId, sessionId: state.sessionId, reason: { _tag: "ManualDeregister" } };
        case "ForceReplace":
          return { _tag: "Expired", agentId: state.agentId, sessionId: state.sessionId, reason: { _tag: "ForceReplaced", newSessionId: event.newSessionId } };
        default: return state;
      }

    case "Reconnecting":
      switch (event._tag) {
        case "Reconnected":
          return { _tag: "Active", agentId: state.agentId, sessionId: state.sessionId, containerId: "" };
        case "ReconnectTimedOut":
          return { _tag: "Expired", agentId: state.agentId, sessionId: state.sessionId, reason: { _tag: "ReconnectTimeout" } };
        case "DeregisterRequested":
          return { _tag: "Expired", agentId: state.agentId, sessionId: state.sessionId, reason: { _tag: "ManualDeregister" } };
        default: return state;
      }

    case "Expired":
      // Any event on Expired → Destroyed
      return { _tag: "Destroyed" };

    case "Destroyed":
      return state; // Terminal state

    default:
      return exhaustive(state);
  }
}

// ---- Token Payload Schema ----

export const TokenPayloadSchema = type({
  sub: /^agent:.+/,
  iss: "'moat-browser'",
  aud: "'moat-browser-gateway'",
  exp: "number",
  iat: "number",
  permissions: {
    profiles: "string[] >= 1",
    maxSessions: "1 <= number <= 10",
    "allowedDomains?": "string[]",
    "budget?": {
      "maxNavigations?": "number >= 0",
      "maxActions?": "number >= 0",
      "maxDurationSeconds?": "number >= 0",
    },
  },
});

export type TokenPayload = typeof TokenPayloadSchema.infer;

// ---- Token Result ADT ----

export type TokenResult =
  | { readonly _tag: "Valid"; readonly payload: TokenPayload }
  | { readonly _tag: "Malformed"; readonly reason: string }
  | { readonly _tag: "SignatureInvalid" }
  | { readonly _tag: "Expired"; readonly expiredAt: string }
  | { readonly _tag: "InsufficientPermissions"; readonly missing: string };

// ---- Registry Result ADT ----

export type RegistryResult =
  | { readonly _tag: "Ok"; readonly sessionId: string }
  | { readonly _tag: "AlreadyRegistered"; readonly existingSessionId: string }
  | { readonly _tag: "SessionNotFound"; readonly sessionId: string }
  | { readonly _tag: "ProfileNotAvailable"; readonly profileName: string };
