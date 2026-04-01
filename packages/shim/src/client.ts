// MoatBrowserClient — Socket.IO client SDK for Controller (design.md §6.1)
import { io, type Socket } from "socket.io-client";
import type {
  BrowserCommand,
  BrowserResult,
  GatewayError,
} from "@moat-browser/types";

// Result subtypes for typed convenience methods
export type NavigateResult = Extract<BrowserResult, { _tag: "NavigateResult" }>;
export type ClickResult = Extract<BrowserResult, { _tag: "ClickResult" }>;
export type FillResult = Extract<BrowserResult, { _tag: "FillResult" }>;
export type SnapshotResult = Extract<BrowserResult, { _tag: "SnapshotResult" }>;
export type ScreenshotResult = Extract<BrowserResult, { _tag: "ScreenshotResult" }>;
export type EvaluateResult = Extract<BrowserResult, { _tag: "EvaluateResult" }>;
export type TabResult = Extract<BrowserResult, { _tag: "TabResult" }>;
export type CommandError = Extract<BrowserResult, { _tag: "CommandError" }>;

export interface RegisterResult {
  readonly _tag: "RegisterResult";
  readonly sessionId: string;
  readonly containerId: string;
}

export interface DeregisterResult {
  readonly _tag: "DeregisterResult";
  readonly sessionId: string;
}

export interface ClientOptions {
  readonly gateway: string;
  readonly token: string;
  readonly agentId: string;
}

type EventHandler<T = unknown> = (payload: T) => void;

type ClientEventMap = {
  sessionExpired: { reason: string };
  disconnected: undefined;
  reconnected: undefined;
  error: GatewayError;
};

export class MoatBrowserClient {
  private readonly opts: ClientOptions;
  private socket: Socket | null = null;
  private sessionId: string | undefined;
  private reconnecting = false;
  private readonly handlers = new Map<string, Set<EventHandler>>();

  constructor(opts: ClientOptions) {
    this.opts = opts;
  }

  // Connect to Controller and register the agent session
  async connect(): Promise<RegisterResult | GatewayError> {
    return new Promise((resolve) => {
      this.socket = io(this.opts.gateway, {
        auth: { token: this.opts.token },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: Infinity,
      });

      this.socket.once("connect_error", (err) => {
        resolve({ _tag: "AuthenticationFailed", reason: err.message });
      });

      this.socket.once("connect", () => {
        this.socket!.emit(
          "register",
          { agentId: this.opts.agentId },
          (result: RegisterResult | GatewayError) => {
            if ("_tag" in result && isGatewayError(result)) {
              resolve(result);
              return;
            }
            const reg = result as RegisterResult;
            this.sessionId = reg.sessionId;
            this._setupListeners();
            resolve(reg);
          }
        );
      });
    });
  }

  // Deregister and close the connection
  async disconnect(): Promise<DeregisterResult | GatewayError> {
    if (!this.socket || !this.sessionId) {
      return { _tag: "SessionNotFound", sessionId: this.sessionId ?? "" };
    }

    return new Promise((resolve) => {
      this.socket!.emit(
        "deregister",
        { sessionId: this.sessionId },
        (result: DeregisterResult | GatewayError) => {
          this.socket!.disconnect();
          this.socket = null;
          this.sessionId = undefined;
          resolve(result);
        }
      );
    });
  }

  // Low-level: send any BrowserCommand and receive BrowserResult | GatewayError
  async command(cmd: BrowserCommand): Promise<BrowserResult | GatewayError> {
    if (this.reconnecting) {
      return { _tag: "CommandError", message: "Reconnecting" };
    }
    if (!this.socket?.connected) {
      return { _tag: "SessionNotReady", state: "disconnected" };
    }

    return new Promise((resolve) => {
      this.socket!.emit("command", cmd, (result: BrowserResult | GatewayError) => {
        resolve(result);
      });
    });
  }

  // Convenience methods — each builds the correct BrowserCommand ADT

  async navigate(url: string): Promise<NavigateResult | CommandError | GatewayError> {
    return this.command({ _tag: "Navigate", url }) as Promise<NavigateResult | CommandError | GatewayError>;
  }

  async click(ref: string): Promise<ClickResult | CommandError | GatewayError> {
    return this.command({ _tag: "Click", ref }) as Promise<ClickResult | CommandError | GatewayError>;
  }

  async fill(ref: string, value: string): Promise<FillResult | CommandError | GatewayError> {
    return this.command({ _tag: "Fill", ref, value }) as Promise<FillResult | CommandError | GatewayError>;
  }

  async snapshot(): Promise<SnapshotResult | CommandError | GatewayError> {
    return this.command({ _tag: "Snapshot" }) as Promise<SnapshotResult | CommandError | GatewayError>;
  }

  async screenshot(): Promise<ScreenshotResult | CommandError | GatewayError> {
    return this.command({ _tag: "Screenshot" }) as Promise<ScreenshotResult | CommandError | GatewayError>;
  }

  async evaluate(expression: string): Promise<EvaluateResult | CommandError | GatewayError> {
    return this.command({ _tag: "Evaluate", expression }) as Promise<EvaluateResult | CommandError | GatewayError>;
  }

  async newTab(url?: string): Promise<TabResult | CommandError | GatewayError> {
    return this.command({ _tag: "NewTab", url }) as Promise<TabResult | CommandError | GatewayError>;
  }

  async switchTab(tabName: string): Promise<TabResult | CommandError | GatewayError> {
    return this.command({ _tag: "SwitchTab", tabName }) as Promise<TabResult | CommandError | GatewayError>;
  }

  async closeTab(tabName: string): Promise<TabResult | CommandError | GatewayError> {
    return this.command({ _tag: "CloseTab", tabName }) as Promise<TabResult | CommandError | GatewayError>;
  }

  async wait(ms: number): Promise<BrowserResult | GatewayError> {
    return this.command({ _tag: "Wait", ms });
  }

  // Event listener registration (design.md §6.1)
  on<K extends keyof ClientEventMap>(
    event: K,
    handler: EventHandler<ClientEventMap[K]>
  ): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler);
  }

  off<K extends keyof ClientEventMap>(
    event: K,
    handler: EventHandler<ClientEventMap[K]>
  ): void {
    this.handlers.get(event)?.delete(handler as EventHandler);
  }

  // Whether the socket is currently connected
  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  // Set up server-push event forwarding (called after successful connect)
  private _setupListeners(): void {
    const socket = this.socket!;

    socket.on("sessionExpired", (payload: { reason: string }) => {
      this._emit("sessionExpired", payload);
    });

    socket.on("disconnect", () => {
      this.reconnecting = true;
      this._emit("disconnected", undefined);
    });

    socket.on("reconnect", () => {
      // design.md §6.3: try resume first, fall back to register
      const savedSessionId = this.sessionId;

      if (savedSessionId) {
        socket.emit(
          "resume",
          { sessionId: savedSessionId },
          (result: { _tag: string; sessionId?: string } | GatewayError) => {
            if (!isGatewayError(result)) {
              // resume succeeded — session restored
              this.reconnecting = false;
              this._emit("reconnected", undefined);
            } else {
              // SessionNotFound or other error — fall back to register
              socket.emit(
                "register",
                { agentId: this.opts.agentId },
                (regResult: RegisterResult | GatewayError) => {
                  if (!isGatewayError(regResult)) {
                    this.sessionId = (regResult as RegisterResult).sessionId;
                    this.reconnecting = false;
                    this._emit("reconnected", undefined);
                  } else {
                    this.reconnecting = false;
                    this._emit("error", regResult as GatewayError);
                  }
                }
              );
            }
          }
        );
      } else {
        // No prior session — just register
        socket.emit(
          "register",
          { agentId: this.opts.agentId },
          (result: RegisterResult | GatewayError) => {
            if (!isGatewayError(result)) {
              this.sessionId = (result as RegisterResult).sessionId;
              this.reconnecting = false;
              this._emit("reconnected", undefined);
            } else {
              this.reconnecting = false;
              this._emit("error", result as GatewayError);
            }
          }
        );
      }
    });
  }

  private _emit<K extends keyof ClientEventMap>(
    event: K,
    payload: ClientEventMap[K]
  ): void {
    const set = this.handlers.get(event);
    if (set) {
      for (const handler of set) {
        handler(payload);
      }
    }
  }
}

function isGatewayError(value: unknown): value is GatewayError {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    [
      "AuthenticationFailed",
      "SessionNotFound",
      "SessionNotReady",
      "ContainerError",
      "CDPError",
      "InternalError",
    ].includes((value as { _tag: string })._tag)
  );
}
