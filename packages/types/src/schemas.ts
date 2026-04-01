import { type } from "arktype";

// TokenPayload schema
export const TokenPayloadSchema = type({
  agentId: "string",
  iat: "number",
  exp: "number",
  "iss?": "string",
});

export type TokenPayload = typeof TokenPayloadSchema.infer;

// BrowserCommand schemas
export const NavigateSchema = type({ _tag: '"Navigate"', url: "string" });
export const ClickSchema = type({ _tag: '"Click"', ref: "string" });
export const FillSchema = type({ _tag: '"Fill"', ref: "string", value: "string" });
export const SnapshotSchema = type({ _tag: '"Snapshot"' });
export const ScreenshotSchema = type({ _tag: '"Screenshot"' });
export const EvaluateSchema = type({ _tag: '"Evaluate"', expression: "string" });
export const NewTabSchema = type({ _tag: '"NewTab"', "url?": "string" });
export const SwitchTabSchema = type({ _tag: '"SwitchTab"', tabId: "string" });
export const CloseTabSchema = type({ _tag: '"CloseTab"', tabId: "string" });
export const WaitSchema = type({ _tag: '"Wait"', ms: "number" });

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

// register event schema
export const RegisterEventSchema = type({ agentId: "string" });
export const ResumeEventSchema = type({ sessionId: "string" });
export const DeregisterEventSchema = type({ sessionId: "string" });

export type RegisterEvent = typeof RegisterEventSchema.infer;
export type ResumeEvent = typeof ResumeEventSchema.infer;
export type DeregisterEvent = typeof DeregisterEventSchema.infer;
