import { exhaustive } from "./exhaustive.js";

// SessionState — all possible states of an agent session
export type SessionState =
  | { readonly _tag: "Registering"; readonly agentId: string }
  | {
      readonly _tag: "CreatingContainer";
      readonly agentId: string;
      readonly profilePath: string;
    }
  | {
      readonly _tag: "ConnectingCDP";
      readonly agentId: string;
      readonly profilePath: string;
      readonly containerId: string;
      readonly containerIp: string;
    }
  | {
      readonly _tag: "Active";
      readonly agentId: string;
      readonly profilePath: string;
      readonly containerId: string;
      readonly containerIp: string;
      readonly sessionId: string;
      readonly lastActivityAt: number;
    }
  | {
      readonly _tag: "Reconnecting";
      readonly agentId: string;
      readonly profilePath: string;
      readonly containerId: string;
      readonly containerIp: string;
      readonly sessionId: string;
      readonly reconnectDeadline: number;
    }
  | {
      readonly _tag: "Expired";
      readonly agentId: string;
      readonly profilePath: string;
      readonly containerId: string;
      readonly sessionId: string;
      readonly reason: string;
    }
  | {
      readonly _tag: "Destroyed";
      readonly agentId: string;
      readonly sessionId: string;
    };

// SessionEvent — all events that drive state transitions
export type SessionEvent =
  | { readonly _tag: "ContainerCreated"; readonly containerId: string; readonly containerIp: string }
  | { readonly _tag: "CDPConnected"; readonly sessionId: string }
  | { readonly _tag: "ActivityRecorded"; readonly at: number }
  | { readonly _tag: "SocketDisconnected" }
  | { readonly _tag: "SocketReconnected" }
  | { readonly _tag: "ReconnectTimeout" }
  | { readonly _tag: "IdleTimeout" }
  | { readonly _tag: "CDPDisconnected"; readonly reason: string }
  | { readonly _tag: "ContainerCrashed"; readonly reason: string }
  | { readonly _tag: "CleanupComplete" };

// transitionSession — exhaustive state machine transition function
export function transitionSession(
  state: SessionState,
  event: SessionEvent
): SessionState {
  switch (state._tag) {
    case "Registering": {
      switch (event._tag) {
        case "ContainerCreated":
          return {
            _tag: "CreatingContainer",
            agentId: state.agentId,
            profilePath: `/data/profiles/${state.agentId}`,
          };
        default:
          return state;
      }
    }

    case "CreatingContainer": {
      switch (event._tag) {
        case "ContainerCreated":
          return {
            _tag: "ConnectingCDP",
            agentId: state.agentId,
            profilePath: state.profilePath,
            containerId: event.containerId,
            containerIp: event.containerIp,
          };
        default:
          return state;
      }
    }

    case "ConnectingCDP": {
      switch (event._tag) {
        case "CDPConnected":
          return {
            _tag: "Active",
            agentId: state.agentId,
            profilePath: state.profilePath,
            containerId: state.containerId,
            containerIp: state.containerIp,
            sessionId: event.sessionId,
            lastActivityAt: Date.now(),
          };
        default:
          return state;
      }
    }

    case "Active": {
      switch (event._tag) {
        case "ActivityRecorded":
          return { ...state, lastActivityAt: event.at };
        case "SocketDisconnected":
          return {
            _tag: "Reconnecting",
            agentId: state.agentId,
            profilePath: state.profilePath,
            containerId: state.containerId,
            containerIp: state.containerIp,
            sessionId: state.sessionId,
            reconnectDeadline: Date.now() + 5_000,
          };
        case "IdleTimeout":
          return {
            _tag: "Expired",
            agentId: state.agentId,
            profilePath: state.profilePath,
            containerId: state.containerId,
            sessionId: state.sessionId,
            reason: "idle timeout",
          };
        case "CDPDisconnected":
          return {
            _tag: "Expired",
            agentId: state.agentId,
            profilePath: state.profilePath,
            containerId: state.containerId,
            sessionId: state.sessionId,
            reason: `CDP disconnected: ${event.reason}`,
          };
        case "ContainerCrashed":
          return {
            _tag: "Expired",
            agentId: state.agentId,
            profilePath: state.profilePath,
            containerId: state.containerId,
            sessionId: state.sessionId,
            reason: `container crashed: ${event.reason}`,
          };
        default:
          return state;
      }
    }

    case "Reconnecting": {
      switch (event._tag) {
        case "SocketReconnected":
          return {
            _tag: "Active",
            agentId: state.agentId,
            profilePath: state.profilePath,
            containerId: state.containerId,
            containerIp: state.containerIp,
            sessionId: state.sessionId,
            lastActivityAt: Date.now(),
          };
        case "ReconnectTimeout":
          return {
            _tag: "Expired",
            agentId: state.agentId,
            profilePath: state.profilePath,
            containerId: state.containerId,
            sessionId: state.sessionId,
            reason: "reconnect timeout",
          };
        case "CDPDisconnected":
          return {
            _tag: "Expired",
            agentId: state.agentId,
            profilePath: state.profilePath,
            containerId: state.containerId,
            sessionId: state.sessionId,
            reason: `CDP disconnected during reconnect: ${event.reason}`,
          };
        default:
          return state;
      }
    }

    case "Expired": {
      switch (event._tag) {
        case "CleanupComplete":
          return {
            _tag: "Destroyed",
            agentId: state.agentId,
            sessionId: state.sessionId,
          };
        default:
          return state;
      }
    }

    case "Destroyed":
      return state;

    default:
      return exhaustive(state);
  }
}
