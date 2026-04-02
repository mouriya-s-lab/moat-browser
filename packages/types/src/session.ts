import { exhaustive } from "./exhaustive";

// Session states
export type Registering = { readonly _tag: "Registering" };
export type CreatingContainer = { readonly _tag: "CreatingContainer" };
export type ConnectingCDP = { readonly _tag: "ConnectingCDP" };
export type Active = { readonly _tag: "Active" };
export type Reconnecting = { readonly _tag: "Reconnecting" };
export type Expired = { readonly _tag: "Expired" };

export type SessionState =
  | Registering
  | CreatingContainer
  | ConnectingCDP
  | Active
  | Reconnecting
  | Expired;

// Session events
export type RegisterEvent = { readonly _tag: "Register" };
export type ContainerCreatedEvent = { readonly _tag: "ContainerCreated" };
export type CDPConnectedEvent = { readonly _tag: "CDPConnected" };
export type SocketDisconnectedEvent = { readonly _tag: "SocketDisconnected" };
export type SocketReconnectedEvent = { readonly _tag: "SocketReconnected" };
export type CDPDisconnectedEvent = { readonly _tag: "CDPDisconnected" };
export type IdleTimeoutEvent = { readonly _tag: "IdleTimeout" };
export type ReconnectTimeoutEvent = { readonly _tag: "ReconnectTimeout" };
export type DeregisterEvent = { readonly _tag: "Deregister" };

export type SessionEvent =
  | RegisterEvent
  | ContainerCreatedEvent
  | CDPConnectedEvent
  | SocketDisconnectedEvent
  | SocketReconnectedEvent
  | CDPDisconnectedEvent
  | IdleTimeoutEvent
  | ReconnectTimeoutEvent
  | DeregisterEvent;

export type TransitionResult =
  | { readonly _tag: "Ok"; readonly state: SessionState }
  | { readonly _tag: "InvalidTransition"; readonly from: string; readonly event: string };

export function transitionSession(state: SessionState, event: SessionEvent): TransitionResult {
  switch (state._tag) {
    case "Registering":
      switch (event._tag) {
        case "Register":
          return { _tag: "Ok", state: { _tag: "CreatingContainer" } };
        case "Deregister":
          return { _tag: "Ok", state: { _tag: "Expired" } };
        default:
          return { _tag: "InvalidTransition", from: state._tag, event: event._tag };
      }

    case "CreatingContainer":
      switch (event._tag) {
        case "ContainerCreated":
          return { _tag: "Ok", state: { _tag: "ConnectingCDP" } };
        case "Deregister":
          return { _tag: "Ok", state: { _tag: "Expired" } };
        default:
          return { _tag: "InvalidTransition", from: state._tag, event: event._tag };
      }

    case "ConnectingCDP":
      switch (event._tag) {
        case "CDPConnected":
          return { _tag: "Ok", state: { _tag: "Active" } };
        case "Deregister":
          return { _tag: "Ok", state: { _tag: "Expired" } };
        default:
          return { _tag: "InvalidTransition", from: state._tag, event: event._tag };
      }

    case "Active":
      switch (event._tag) {
        case "SocketDisconnected":
          return { _tag: "Ok", state: { _tag: "Reconnecting" } };
        case "CDPDisconnected":
          return { _tag: "Ok", state: { _tag: "Expired" } };
        case "IdleTimeout":
          return { _tag: "Ok", state: { _tag: "Expired" } };
        case "Deregister":
          return { _tag: "Ok", state: { _tag: "Expired" } };
        default:
          return { _tag: "InvalidTransition", from: state._tag, event: event._tag };
      }

    case "Reconnecting":
      switch (event._tag) {
        case "SocketReconnected":
          return { _tag: "Ok", state: { _tag: "Active" } };
        case "ReconnectTimeout":
          return { _tag: "Ok", state: { _tag: "Expired" } };
        case "CDPDisconnected":
          return { _tag: "Ok", state: { _tag: "Expired" } };
        case "Deregister":
          return { _tag: "Ok", state: { _tag: "Expired" } };
        default:
          return { _tag: "InvalidTransition", from: state._tag, event: event._tag };
      }

    case "Expired":
      return { _tag: "InvalidTransition", from: state._tag, event: event._tag };

    default:
      return exhaustive(state);
  }
}
