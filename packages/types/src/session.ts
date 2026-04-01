import { exhaustive } from "./exhaustive.js";
import type { GatewayError } from "./messages.js";

// ---- Session State ADT ----

export type ExpireReason =
  | "IdleTimeout"
  | "ReconnectTimeout"
  | "ContainerCrashed"
  | "TokenExpired";

export type SessionState =
  | { readonly _tag: "Registering"; readonly agentId: string }
  | { readonly _tag: "CreatingContainer"; readonly agentId: string; readonly containerId: string }
  | { readonly _tag: "ConnectingCDP"; readonly agentId: string; readonly containerId: string }
  | {
      readonly _tag: "Active";
      readonly agentId: string;
      readonly sessionId: string;
      readonly containerId: string;
    }
  | {
      readonly _tag: "Reconnecting";
      readonly agentId: string;
      readonly sessionId: string;
      readonly containerId: string;
      readonly disconnectedAt: string;
    }
  | {
      readonly _tag: "Expired";
      readonly agentId: string;
      readonly sessionId: string;
      readonly reason: ExpireReason;
    }
  | { readonly _tag: "Destroyed" };

// ---- Session Event ADT ----

export type SessionEvent =
  | { readonly _tag: "ContainerCreated"; readonly containerId: string }
  | { readonly _tag: "CDPConnected"; readonly sessionId: string }
  | { readonly _tag: "CommandReceived" }
  | { readonly _tag: "IdleTimerFired" }
  | { readonly _tag: "SocketDisconnected" }
  | { readonly _tag: "ResumeReceived" }
  | { readonly _tag: "ReconnectTimerFired" }
  | { readonly _tag: "CDPDisconnected" }
  | { readonly _tag: "CleanupComplete" };

// ---- State Transition Function ----

export type TransitionResult =
  | { readonly ok: true; readonly next: SessionState }
  | { readonly ok: false; readonly error: GatewayError };

export function transitionSession(
  state: SessionState,
  event: SessionEvent
): TransitionResult {
  switch (state._tag) {
    case "Registering": {
      switch (event._tag) {
        case "ContainerCreated":
          return {
            ok: true,
            next: {
              _tag: "CreatingContainer",
              agentId: state.agentId,
              containerId: event.containerId,
            },
          };
        default:
          return {
            ok: false,
            error: { _tag: "SessionNotReady", state: state._tag },
          };
      }
    }

    case "CreatingContainer": {
      switch (event._tag) {
        case "CDPConnected":
          return {
            ok: true,
            next: {
              _tag: "ConnectingCDP",
              agentId: state.agentId,
              containerId: state.containerId,
            },
          };
        default:
          return {
            ok: false,
            error: { _tag: "SessionNotReady", state: state._tag },
          };
      }
    }

    case "ConnectingCDP": {
      switch (event._tag) {
        case "CDPConnected":
          return {
            ok: true,
            next: {
              _tag: "Active",
              agentId: state.agentId,
              sessionId: event.sessionId,
              containerId: state.containerId,
            },
          };
        default:
          return {
            ok: false,
            error: { _tag: "SessionNotReady", state: state._tag },
          };
      }
    }

    case "Active": {
      switch (event._tag) {
        case "CommandReceived":
          return { ok: true, next: state };
        case "IdleTimerFired":
          return {
            ok: true,
            next: {
              _tag: "Expired",
              agentId: state.agentId,
              sessionId: state.sessionId,
              reason: "IdleTimeout",
            },
          };
        case "SocketDisconnected":
          return {
            ok: true,
            next: {
              _tag: "Reconnecting",
              agentId: state.agentId,
              sessionId: state.sessionId,
              containerId: state.containerId,
              disconnectedAt: new Date().toISOString(),
            },
          };
        case "CDPDisconnected":
          return {
            ok: true,
            next: {
              _tag: "Expired",
              agentId: state.agentId,
              sessionId: state.sessionId,
              reason: "ContainerCrashed",
            },
          };
        default:
          return {
            ok: false,
            error: { _tag: "SessionNotReady", state: state._tag },
          };
      }
    }

    case "Reconnecting": {
      switch (event._tag) {
        case "ResumeReceived":
          return {
            ok: true,
            next: {
              _tag: "Active",
              agentId: state.agentId,
              sessionId: state.sessionId,
              containerId: state.containerId,
            },
          };
        case "ReconnectTimerFired":
          return {
            ok: true,
            next: {
              _tag: "Expired",
              agentId: state.agentId,
              sessionId: state.sessionId,
              reason: "ReconnectTimeout",
            },
          };
        default:
          return {
            ok: false,
            error: { _tag: "SessionNotReady", state: state._tag },
          };
      }
    }

    case "Expired": {
      switch (event._tag) {
        case "CleanupComplete":
          return { ok: true, next: { _tag: "Destroyed" } };
        default:
          return {
            ok: false,
            error: { _tag: "SessionNotFound", sessionId: state.sessionId },
          };
      }
    }

    case "Destroyed": {
      return {
        ok: false,
        error: {
          _tag: "InternalError",
          message: `Cannot transition Destroyed session on event ${event._tag}`,
        },
      };
    }

    default:
      return exhaustive(state);
  }
}
