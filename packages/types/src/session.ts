import { exhaustive } from "./exhaustive";

export type SessionState =
  | { readonly _tag: "Registering" }
  | { readonly _tag: "CreatingContainer" }
  | { readonly _tag: "ConnectingCDP" }
  | { readonly _tag: "Active" }
  | { readonly _tag: "Reconnecting" }
  | { readonly _tag: "Expired" };

export type SessionEvent =
  | { readonly _tag: "StartCreating" }
  | { readonly _tag: "ContainerCreated" }
  | { readonly _tag: "CdpConnected" }
  | { readonly _tag: "IdleTimeout" }
  | { readonly _tag: "CdpDisconnected" }
  | { readonly _tag: "SocketDisconnected" }
  | { readonly _tag: "SocketReconnected" }
  | { readonly _tag: "ReconnectTimeout" }
  | { readonly _tag: "Error"; readonly message: string };

export type TransitionError = {
  readonly _tag: "TransitionError";
  readonly from: string;
  readonly event: string;
  readonly message: string;
};

function invalidTransition(from: string, event: string): TransitionError {
  return {
    _tag: "TransitionError",
    from,
    event,
    message: `Invalid transition from ${from} on ${event}`,
  };
}

export function transitionSession(
  state: SessionState,
  event: SessionEvent
): SessionState | TransitionError {
  switch (state._tag) {
    case "Registering":
      switch (event._tag) {
        case "StartCreating":
          return { _tag: "CreatingContainer" };
        case "Error":
          return { _tag: "Expired" };
        default:
          return invalidTransition(state._tag, event._tag);
      }
    case "CreatingContainer":
      switch (event._tag) {
        case "ContainerCreated":
          return { _tag: "ConnectingCDP" };
        case "Error":
          return { _tag: "Expired" };
        default:
          return invalidTransition(state._tag, event._tag);
      }
    case "ConnectingCDP":
      switch (event._tag) {
        case "CdpConnected":
          return { _tag: "Active" };
        case "Error":
          return { _tag: "Expired" };
        default:
          return invalidTransition(state._tag, event._tag);
      }
    case "Active":
      switch (event._tag) {
        case "IdleTimeout":
          return { _tag: "Expired" };
        case "CdpDisconnected":
          return { _tag: "Expired" };
        case "SocketDisconnected":
          return { _tag: "Reconnecting" };
        case "Error":
          return { _tag: "Expired" };
        default:
          return invalidTransition(state._tag, event._tag);
      }
    case "Reconnecting":
      switch (event._tag) {
        case "SocketReconnected":
          return { _tag: "Active" };
        case "ReconnectTimeout":
          return { _tag: "Expired" };
        case "Error":
          return { _tag: "Expired" };
        default:
          return invalidTransition(state._tag, event._tag);
      }
    case "Expired":
      return {
        _tag: "TransitionError",
        from: "Expired",
        event: event._tag,
        message: "Session is expired, no transitions allowed",
      };
    default:
      return exhaustive(state);
  }
}
