import { io, type Socket } from "socket.io-client";
import type {
  BrowserCommand,
  BrowserResult,
  ServerEvent,
  GatewayError,
  ExpireReason,
} from "@moat-browser/types";
import type { ShimConfig } from "./config.js";

type EventHandler<T> = (data: T) => void;

export class MoatBrowserClient {
  private socket: Socket | null = null;
  private sessionId: string | null = null;
  private config: ShimConfig;
  private handlers = {
    sessionExpired: [] as EventHandler<ExpireReason>[],
    disconnected: [] as EventHandler<void>[],
    reconnected: [] as EventHandler<void>[],
    error: [] as EventHandler<GatewayError>[],
  };

  constructor(config: ShimConfig) {
    this.config = config;
  }

  // ---- Lifecycle ----

  async connect(): Promise<{ sessionId: string; expiresAt: string }> {
    return new Promise((resolve, reject) => {
      this.socket = io(this.config.gateway, {
        auth: { token: this.config.token },
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 100,
        reconnectionDelayMax: 30_000,
      });

      this.socket.on("connect", () => {
        this.sendEvent(
          {
            _tag: "Register",
            agentId: this.config.agentId,
            profile: this.config.profile,
            token: this.config.token,
            instance: this.config.instance,
          },
          (response: ServerEvent) => {
            if (response._tag === "Registered") {
              this.sessionId = response.sessionId;
              resolve({ sessionId: response.sessionId, expiresAt: response.expiresAt });
            } else if (response._tag === "Error") {
              reject(new Error(`Registration failed: ${response.error._tag}`));
            } else {
              reject(new Error(`Unexpected response: ${response._tag}`));
            }
          },
        );
      });

      this.socket.on("connect_error", (err) => {
        reject(new Error(`Connection failed: ${err.message}`));
      });

      this.socket.on("disconnect", () => {
        for (const h of this.handlers.disconnected) h();
      });

      this.socket.io.on("reconnect", () => {
        // Re-register on reconnect
        if (this.socket) {
          this.sendEvent(
            {
              _tag: "Register",
              agentId: this.config.agentId,
              profile: this.config.profile,
              token: this.config.token,
              instance: this.config.instance,
            },
            (response: ServerEvent) => {
              if (response._tag === "Registered") {
                this.sessionId = response.sessionId;
                for (const h of this.handlers.reconnected) h();
              }
            },
          );
        }
      });

      // Server-pushed events
      this.socket.on("event", (event: ServerEvent) => {
        if (event._tag === "SessionExpired") {
          for (const h of this.handlers.sessionExpired) {
            h({ _tag: "ManualDeregister" }); // Default reason
          }
        } else if (event._tag === "Error") {
          for (const h of this.handlers.error) h(event.error);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.socket || !this.sessionId) return;

    return new Promise((resolve) => {
      this.sendEvent(
        { _tag: "Deregister", sessionId: this.sessionId! },
        () => {
          this.socket?.disconnect();
          this.socket = null;
          this.sessionId = null;
          resolve();
        },
      );
    });
  }

  // ---- Browser Commands ----

  async navigate(url: string) {
    return this.command({ _tag: "Navigate", url });
  }

  async click(ref: string) {
    return this.command({ _tag: "Click", ref });
  }

  async fill(ref: string, value: string) {
    return this.command({ _tag: "Fill", ref, value });
  }

  async snapshot() {
    return this.command({ _tag: "Snapshot" });
  }

  async screenshot() {
    return this.command({ _tag: "Screenshot" });
  }

  async evaluate(expression: string) {
    return this.command({ _tag: "Evaluate", expression });
  }

  async getCookies() {
    return this.command({ _tag: "GetCookies" });
  }

  async newTab(url?: string) {
    return this.command(url ? { _tag: "NewTab", url } : { _tag: "NewTab" });
  }

  async switchTab(tabName: string) {
    return this.command({ _tag: "SwitchTab", tabName });
  }

  async closeTab(tabName: string) {
    return this.command({ _tag: "CloseTab", tabName });
  }

  async wait(ms: number) {
    return this.command({ _tag: "Wait", ms });
  }

  // ---- Generic Command ----

  async command(cmd: BrowserCommand): Promise<BrowserResult> {
    if (!this.socket || !this.sessionId) {
      return { _tag: "CommandError", message: "Not connected" };
    }

    return new Promise((resolve) => {
      this.sendEvent(
        { _tag: "Command", sessionId: this.sessionId!, command: cmd },
        (response: ServerEvent) => {
          if (response._tag === "CommandResult") {
            resolve(response.result);
          } else if (response._tag === "Error") {
            resolve({ _tag: "CommandError", message: response.error._tag });
          } else if (response._tag === "SessionExpired") {
            resolve({ _tag: "CommandError", message: `Session expired: ${response.reason}` });
          } else {
            resolve({ _tag: "CommandError", message: `Unexpected: ${response._tag}` });
          }
        },
      );
    });
  }

  // ---- Profile Operations ----

  async listProfiles(): Promise<ServerEvent> {
    return this.sendEventAsync({ _tag: "ListProfiles" });
  }

  async startUserChrome(profileName: string): Promise<ServerEvent> {
    return this.sendEventAsync({ _tag: "StartUserChrome", profileName });
  }

  async stopUserChrome(): Promise<ServerEvent> {
    return this.sendEventAsync({ _tag: "StopUserChrome" });
  }

  async freezeProfile(profileName: string): Promise<ServerEvent> {
    return this.sendEventAsync({ _tag: "FreezeProfile", profileName });
  }

  // ---- Events ----

  on(event: "sessionExpired", handler: EventHandler<ExpireReason>): void;
  on(event: "disconnected", handler: EventHandler<void>): void;
  on(event: "reconnected", handler: EventHandler<void>): void;
  on(event: "error", handler: EventHandler<GatewayError>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: "sessionExpired" | "disconnected" | "reconnected" | "error", handler: EventHandler<any>): void {
    const key = event as keyof typeof this.handlers;
    if (key in this.handlers) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.handlers[key] as EventHandler<any>[]).push(handler);
    }
  }

  // ---- Internal ----

  private sendEvent(data: unknown, ack: (response: ServerEvent) => void): void {
    this.socket?.emit("event", data, ack);
  }

  private sendEventAsync(data: unknown): Promise<ServerEvent> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error("Not connected"));
        return;
      }
      this.socket.emit("event", data, (response: ServerEvent) => {
        resolve(response);
      });
    });
  }
}
