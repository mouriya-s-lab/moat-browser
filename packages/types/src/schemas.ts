import { type } from "arktype";

// ---- TokenPayload schema (design.md §7.5) ----

export const TokenPayloadSchema = type({
  sub: "string",
  iss: "'moat-browser'",
  aud: "'moat-browser-controller'",
  exp: "number",
  iat: "number",
});

export type TokenPayload = typeof TokenPayloadSchema.infer;

// ---- BrowserCommand schemas ----

export const NavigateSchema = type({ _tag: "'Navigate'", url: "string" });
export const ClickSchema = type({ _tag: "'Click'", ref: "string" });
export const FillSchema = type({ _tag: "'Fill'", ref: "string", value: "string" });
export const SnapshotSchema = type({ _tag: "'Snapshot'" });
export const ScreenshotSchema = type({ _tag: "'Screenshot'" });
export const EvaluateSchema = type({ _tag: "'Evaluate'", expression: "string" });
export const NewTabSchema = type({ _tag: "'NewTab'", "url?": "string" });
export const SwitchTabSchema = type({ _tag: "'SwitchTab'", tabName: "string" });
export const CloseTabSchema = type({ _tag: "'CloseTab'", tabName: "string" });
export const WaitSchema = type({ _tag: "'Wait'", ms: "number" });

export const BrowserCommandSchema = NavigateSchema
  .or(ClickSchema)
  .or(FillSchema)
  .or(SnapshotSchema)
  .or(ScreenshotSchema)
  .or(EvaluateSchema)
  .or(NewTabSchema)
  .or(SwitchTabSchema)
  .or(CloseTabSchema)
  .or(WaitSchema);

// ---- Socket.IO event payload schemas ----

export const RegisterPayloadSchema = type({ agentId: "string" });
export const ResumePayloadSchema = type({ sessionId: "string" });
export const DeregisterPayloadSchema = type({ sessionId: "string" });
