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

// ---- Legacy data schemas (kept for backward compat) ----

export const ContainerInfoSchema = type({
  containerId: "string",
  agentId: "string",
  profileName: "string",
  state: "'creating' | 'running' | 'stopping' | 'destroyed'",
  createdAt: "string",
  "socketPath?": "string",
});

export const ProfileInfoSchema = type({
  name: "string",
  frozen: "boolean",
  "frozenAt?": "string",
  "chromiumVersion?": "string",
  sizeBytes: "number",
});

export const HealthInfoSchema = type({
  agentId: "string",
  containerId: "string",
  cdpResponding: "boolean",
  socketResponding: "boolean",
  uptimeSeconds: "number",
});

// ---- Request schemas ----

const slugPattern = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

export const CreateAgentBrowserSchema = type({
  _tag: "'CreateAgentBrowser'",
  agentId: slugPattern,
  profileName: slugPattern,
});

export const DestroyAgentBrowserSchema = type({
  _tag: "'DestroyAgentBrowser'",
  agentId: slugPattern,
});

export const GetAgentBrowserSchema = type({
  _tag: "'GetAgentBrowser'",
  agentId: slugPattern,
});

export const ListAgentBrowsersSchema = type({
  _tag: "'ListAgentBrowsers'",
});

export const StartUserChromeSchema = type({
  _tag: "'StartUserChrome'",
  profileName: slugPattern,
});

export const StopUserChromeSchema = type({
  _tag: "'StopUserChrome'",
});

export const FreezeProfileSchema = type({
  _tag: "'FreezeProfile'",
  profileName: slugPattern,
});

export const ListProfilesSchema = type({
  _tag: "'ListProfiles'",
});

export const DeleteProfileSchema = type({
  _tag: "'DeleteProfile'",
  profileName: slugPattern,
});

export const HealthCheckSchema = type({
  _tag: "'HealthCheck'",
  agentId: slugPattern,
});

export const ControllerRequestSchema = CreateAgentBrowserSchema
  .or(DestroyAgentBrowserSchema)
  .or(GetAgentBrowserSchema)
  .or(ListAgentBrowsersSchema)
  .or(StartUserChromeSchema)
  .or(StopUserChromeSchema)
  .or(FreezeProfileSchema)
  .or(ListProfilesSchema)
  .or(DeleteProfileSchema)
  .or(HealthCheckSchema);
