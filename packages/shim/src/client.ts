/**
 * client.ts — MoatBrowserClient SDK
 *
 * Connects to the Controller via Socket.IO.
 * Provides type-safe wrappers for all BrowserCommands.
 * Supports auto-reconnect via Socket.IO built-in + resume event.
 */

import { io, type Socket } from "socket.io-client";
import type {
  BrowserCommand,
  BrowserResult,
  GatewayError,
} from "@moat-browser/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServerToClientEvents {
  error: (err: GatewayError) => void;
  registered: (data: { sessionId: string }) => void;
  resumed: (data: { sessionId: string }) => void;
  result: (data: BrowserResult) => void;
  deregistered: (data: { sessionId: string }) => void;
}

interface ClientToServerEvents {
  register: (
    data: { agentId: string },
    cb: (err: GatewayError | null, result?: { sessionId: string }) => void
  ) => void;
  resume: (
    data: { sessionId: string },
    cb: (err: GatewayError | null, result?: { sessionId: string }) => void
  ) => void;
  command: (
    data: BrowserCommand,
    cb: (err: GatewayError | null, result?: BrowserResult) => void
  ) => void;
  deregister: (
    data: { sessionId: string },
    cb: (err: GatewayError | null, result?: { sessionId: string }) => void
  ) => void;
}

export type ClientEvent = "sessionExpired" | "disconnected" | "reconnected" | "error";

export type NavigateResult = Extract<BrowserResult, { _tag: "NavigateResult" }>;
export type ClickResult = Extract<BrowserResult, { _tag: "ClickResult" }>;
export type FillResult = Extract<BrowserResult, { _tag: "FillResult" }>;
export type SnapshotResult = Extract<BrowserResult, { _tag: "SnapshotResult" }>;
export type ScreenshotResult = Extract<BrowserResult, { _tag: "ScreenshotResult" }>;
export type EvaluateResult = Extract<BrowserResult, { _tag: "EvaluateResult" }>;
export type TabResult =
  | Extract<BrowserResult, { _tag: "NewTabResult" }>
  | Extract<BrowserResult, { _tag: "SwitchTabResult" }>
  | Extract<BrowserResult, { _tag: "CloseTabResult" }>;
export type CommandError = GatewayError;

export type RegisterResult = { sessionId: string };

// ---------------------------------------------------------------------------
// MoatBrowserClient
// ---------------------------------------------------------------------------

export class MoatBrowserClient {
  private readonly _gateway: string;
  private readonly _token: string;
  private readonly _agentId: string;
  private _socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private _sessionId: string | null = null;
  private readonly _handlers = new Map<ClientEvent, Array<(...args: unknown[]) => void>>();

  constructor(opts: { gateway: string; token: string; agentId: string }) {
    this._gateway = opts.gateway;
    this._token = opts.token;
    this._agentId = opts.agentId;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Connect to gateway and register a new session. */
  async connect(): Promise<RegisterResult | CommandError> {
    if (this._socket?.connected && this._sessionId) {
      return { sessionId: this._sessionId };
    }

    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(this._gateway, {
      auth: { token: this._token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });

    this._socket = socket;

    // Wait for connection
    const connectErr = await new Promise<Error | null>((resolve) => {
      const timeout = setTimeout(() => resolve(new Error("Connection timeout")), 30_000);
      socket.once("connect", () => {
        clearTimeout(timeout);
        resolve(null);
      });
      socket.once("connect_error", (err) => {
        clearTimeout(timeout);
        resolve(err);
      });
    });

    if (connectErr) {
      socket.disconnect();
      this._socket = null;
      return { _tag: "AuthError", message: connectErr.message };
    }

    // Wire reconnect handler to resume session
    socket.on("disconnect", (reason) => {
      this._emit("disconnected", reason);
      // On transport close, try to resume on reconnect
    });

    socket.on("connect", () => {
      // Reconnected — try to resume existing session
      if (this._sessionId) {
        this._resumeSession(this._sessionId).catch(() => {});
        this._emit("reconnected");
      }
    });

    // Register
    const registerResult = await this._register();
    return registerResult;
  }

  /** Gracefully disconnect and destroy session. */
  async disconnect(): Promise<void> {
    if (!this._socket || !this._sessionId) {
      this._socket?.disconnect();
      this._socket = null;
      return;
    }

    await new Promise<void>((resolve) => {
      const sessionId = this._sessionId!;
      this._socket!.emit("deregister", { sessionId }, (err) => {
        void err; // ignore errors on disconnect
        resolve();
      });
    });

    this._sessionId = null;
    this._socket.disconnect();
    this._socket = null;
  }

  // -------------------------------------------------------------------------
  // Browser commands (typed wrappers)
  // -------------------------------------------------------------------------

  async navigate(url: string): Promise<NavigateResult | CommandError> {
    return this._typed<NavigateResult>({ _tag: "Navigate", url });
  }

  async click(ref: string): Promise<ClickResult | CommandError> {
    return this._typed<ClickResult>({ _tag: "Click", ref });
  }

  async fill(ref: string, value: string): Promise<FillResult | CommandError> {
    return this._typed<FillResult>({ _tag: "Fill", ref, value });
  }

  async snapshot(): Promise<SnapshotResult | CommandError> {
    return this._typed<SnapshotResult>({ _tag: "Snapshot" });
  }

  async screenshot(): Promise<ScreenshotResult | CommandError> {
    return this._typed<ScreenshotResult>({ _tag: "Screenshot" });
  }

  async evaluate(expression: string): Promise<EvaluateResult | CommandError> {
    return this._typed<EvaluateResult>({ _tag: "Evaluate", expression });
  }

  async newTab(url?: string): Promise<TabResult | CommandError> {
    return this._typed<Extract<BrowserResult, { _tag: "NewTabResult" }>>(
      url !== undefined ? { _tag: "NewTab", url } : { _tag: "NewTab" }
    );
  }

  async switchTab(tabId: string): Promise<TabResult | CommandError> {
    return this._typed<Extract<BrowserResult, { _tag: "SwitchTabResult" }>>({
      _tag: "SwitchTab",
      tabId,
    });
  }

  async closeTab(tabId: string): Promise<TabResult | CommandError> {
    return this._typed<Extract<BrowserResult, { _tag: "CloseTabResult" }>>({
      _tag: "CloseTab",
      tabId,
    });
  }

  async wait(ms: number): Promise<Extract<BrowserResult, { _tag: "WaitResult" }> | CommandError> {
    return this._typed<Extract<BrowserResult, { _tag: "WaitResult" }>>({
      _tag: "Wait",
      ms,
    });
  }

  /** Low-level command — send any BrowserCommand, receive BrowserResult or GatewayError. */
  async command(cmd: BrowserCommand): Promise<BrowserResult | GatewayError> {
    return this._sendCommand(cmd);
  }

  /**
   * Resume a previously-established session by its ID.
   * Used in reconnect scenarios and E2E tests.
   */
  async resume(sessionId: string): Promise<RegisterResult | CommandError> {
    if (!this._socket?.connected) {
      return { _tag: "InternalError", message: "Not connected" };
    }
    return new Promise((resolve) => {
      this._socket!.emit("resume", { sessionId }, (err, result) => {
        if (err) {
          resolve(err);
          return;
        }
        if (!result) {
          resolve({ _tag: "InternalError", message: "No result from resume" });
          return;
        }
        this._sessionId = result.sessionId;
        resolve({ sessionId: result.sessionId });
      });
    });
  }

  /**
   * Drop the transport connection without deregistering.
   * Simulates an abnormal disconnect for testing reconnect behaviour.
   */
  forceDisconnect(): void {
    this._socket?.disconnect();
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on(event: ClientEvent, handler: (...args: unknown[]) => void): void {
    const list = this._handlers.get(event) ?? [];
    list.push(handler);
    this._handlers.set(event, list);
  }

  off(event: ClientEvent, handler: (...args: unknown[]) => void): void {
    const list = this._handlers.get(event) ?? [];
    this._handlers.set(
      event,
      list.filter((h) => h !== handler)
    );
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  get sessionId(): string | null {
    return this._sessionId;
  }

  get connected(): boolean {
    return this._socket?.connected ?? false;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async _register(): Promise<RegisterResult | CommandError> {
    return new Promise((resolve) => {
      this._socket!.emit("register", { agentId: this._agentId }, (err, result) => {
        if (err) {
          resolve(err);
          return;
        }
        if (!result) {
          resolve({ _tag: "InternalError", message: "No result from register" });
          return;
        }
        this._sessionId = result.sessionId;
        resolve({ sessionId: result.sessionId });
      });
    });
  }

  private async _resumeSession(sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      this._socket!.emit("resume", { sessionId }, (err, result) => {
        if (err) {
          this._emit("sessionExpired", sessionId);
          // Session gone — try to register a new one
          void this._register().then((r) => {
            if ("_tag" in r) {
              this._emit("error", r);
            }
          });
        } else {
          if (result) {
            this._sessionId = result.sessionId;
          }
          this._emit("reconnected");
        }
        resolve();
      });
    });
  }

  private async _sendCommand(cmd: BrowserCommand): Promise<BrowserResult | GatewayError> {
    if (!this._socket?.connected) {
      return { _tag: "InternalError", message: "Not connected" };
    }
    if (!this._sessionId) {
      return { _tag: "SessionNotFound", sessionId: "<none>" };
    }

    return new Promise((resolve) => {
      this._socket!.emit("command", cmd, (err, result) => {
        if (err) {
          resolve(err);
          return;
        }
        if (!result) {
          resolve({ _tag: "InternalError", message: "No result from command" });
          return;
        }
        resolve(result);
      });
    });
  }

  private _typed<T extends BrowserResult>(
    cmd: BrowserCommand
  ): Promise<T | GatewayError> {
    return this._sendCommand(cmd) as Promise<T | GatewayError>;
  }

  private _emit(event: ClientEvent, ...args: unknown[]): void {
    const handlers = this._handlers.get(event) ?? [];
    for (const h of handlers) {
      h(...args);
    }
  }
}
