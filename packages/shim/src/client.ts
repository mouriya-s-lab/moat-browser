import type { Socket } from "socket.io-client";
import type { BrowserCommand, BrowserResult, GatewayError } from "@moat-browser/types";

// --- Response validation (manual type guards) ---

const GATEWAY_ERROR_TAGS: ReadonlySet<string> = new Set([
  "AuthError",
  "SessionNotFound",
  "SessionExpired",
  "CommandError",
  "ContainerError",
  "ValidationError",
]);

const BROWSER_RESULT_TAGS: ReadonlySet<string> = new Set([
  "NavigateResult",
  "ClickResult",
  "FillResult",
  "SnapshotResult",
  "ScreenshotResult",
  "EvaluateResult",
  "TabResult",
  "WaitResult",
]);

function hasTag(value: unknown): value is { readonly _tag: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    typeof (value as Record<string, unknown>)["_tag"] === "string"
  );
}

function isGatewayError(value: unknown): value is GatewayError {
  return hasTag(value) && GATEWAY_ERROR_TAGS.has(value._tag);
}

function isBrowserResult(value: unknown): value is BrowserResult {
  return hasTag(value) && BROWSER_RESULT_TAGS.has(value._tag);
}

function isRegisterSuccess(value: unknown): value is { readonly sessionId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "sessionId" in value &&
    typeof (value as Record<string, unknown>)["sessionId"] === "string"
  );
}

// --- Response validators ---

export function validateRegisterResponse(
  data: unknown
): { readonly sessionId: string } | GatewayError {
  if (isGatewayError(data)) return data;
  if (isRegisterSuccess(data)) return data;
  return {
    _tag: "ValidationError",
    message: `Invalid register response: ${JSON.stringify(data)}`,
  };
}

export function validateCommandResponse(
  data: unknown
): BrowserResult | GatewayError {
  if (isGatewayError(data)) return data;
  if (isBrowserResult(data)) return data;
  return {
    _tag: "ValidationError",
    message: `Invalid command response: ${JSON.stringify(data)}`,
  };
}

// --- Result extraction helpers ---

type ExtractResult<Tag extends BrowserResult["_tag"]> = Extract<
  BrowserResult,
  { readonly _tag: Tag }
>;

function extractResult<Tag extends BrowserResult["_tag"]>(
  response: BrowserResult | GatewayError,
  expectedTag: Tag
): ExtractResult<Tag> | GatewayError {
  if (isGatewayError(response)) return response;
  if (response._tag !== expectedTag) {
    return {
      _tag: "ValidationError",
      message: `Expected ${expectedTag}, got ${response._tag}`,
    };
  }
  return response as ExtractResult<Tag>;
}

// --- Socket.IO emit helper ---

function emitWithCallback(
  socket: Socket,
  event: string,
  data: unknown
): Promise<unknown> {
  return new Promise((resolve) => {
    socket.emit(event, data, (response: unknown) => {
      resolve(response);
    });
  });
}

function emitWithCallbackNoData(
  socket: Socket,
  event: string
): Promise<unknown> {
  return new Promise((resolve) => {
    socket.emit(event, (response: unknown) => {
      resolve(response);
    });
  });
}

// --- BrowserClient ---

export class BrowserClient {
  readonly sessionId: string;
  private readonly socket: Socket;

  constructor(sessionId: string, socket: Socket) {
    this.sessionId = sessionId;
    this.socket = socket;
  }

  private async sendCommand(
    command: BrowserCommand
  ): Promise<BrowserResult | GatewayError> {
    const raw = await emitWithCallback(this.socket, "command", command);
    return validateCommandResponse(raw);
  }

  async navigate(
    url: string
  ): Promise<ExtractResult<"NavigateResult"> | GatewayError> {
    const response = await this.sendCommand({ _tag: "Navigate", url });
    return extractResult(response, "NavigateResult");
  }

  async click(
    selector: string
  ): Promise<ExtractResult<"ClickResult"> | GatewayError> {
    const response = await this.sendCommand({ _tag: "Click", selector });
    return extractResult(response, "ClickResult");
  }

  async fill(
    selector: string,
    value: string
  ): Promise<ExtractResult<"FillResult"> | GatewayError> {
    const response = await this.sendCommand({
      _tag: "Fill",
      selector,
      value,
    });
    return extractResult(response, "FillResult");
  }

  async snapshot(): Promise<
    ExtractResult<"SnapshotResult"> | GatewayError
  > {
    const response = await this.sendCommand({ _tag: "Snapshot" });
    return extractResult(response, "SnapshotResult");
  }

  async screenshot(): Promise<
    ExtractResult<"ScreenshotResult"> | GatewayError
  > {
    const response = await this.sendCommand({ _tag: "Screenshot" });
    return extractResult(response, "ScreenshotResult");
  }

  async evaluate(
    expression: string
  ): Promise<ExtractResult<"EvaluateResult"> | GatewayError> {
    const response = await this.sendCommand({
      _tag: "Evaluate",
      expression,
    });
    return extractResult(response, "EvaluateResult");
  }

  async newTab(
    url?: string
  ): Promise<ExtractResult<"TabResult"> | GatewayError> {
    const command: BrowserCommand =
      url !== undefined ? { _tag: "NewTab", url } : { _tag: "NewTab" };
    const response = await this.sendCommand(command);
    return extractResult(response, "TabResult");
  }

  async switchTab(
    index: number
  ): Promise<ExtractResult<"TabResult"> | GatewayError> {
    const response = await this.sendCommand({ _tag: "SwitchTab", index });
    return extractResult(response, "TabResult");
  }

  async closeTab(
    index: number
  ): Promise<ExtractResult<"TabResult"> | GatewayError> {
    const response = await this.sendCommand({ _tag: "CloseTab", index });
    return extractResult(response, "TabResult");
  }

  async wait(
    selector: string,
    timeout?: number
  ): Promise<ExtractResult<"WaitResult"> | GatewayError> {
    const command: BrowserCommand =
      timeout !== undefined
        ? { _tag: "Wait", selector, timeout }
        : { _tag: "Wait", selector };
    const response = await this.sendCommand(command);
    return extractResult(response, "WaitResult");
  }

  async disconnect(): Promise<void> {
    await emitWithCallbackNoData(this.socket, "deregister");
    this.socket.disconnect();
  }
}
