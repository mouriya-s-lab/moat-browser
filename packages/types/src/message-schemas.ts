import { type } from "arktype";

const slugPattern = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

// ---- Browser Command Schemas ----

export const NavigateCommandSchema = type({
  _tag: "'Navigate'",
  url: /^https?:\/\/.+/,
});

export const ClickCommandSchema = type({
  _tag: "'Click'",
  ref: "string > 0",
});

export const FillCommandSchema = type({
  _tag: "'Fill'",
  ref: "string > 0",
  value: "string",
});

export const SnapshotCommandSchema = type({ _tag: "'Snapshot'" });
export const ScreenshotCommandSchema = type({ _tag: "'Screenshot'" });

export const WaitCommandSchema = type({
  _tag: "'Wait'",
  ms: "number > 0",
});

export const EvaluateCommandSchema = type({
  _tag: "'Evaluate'",
  expression: "string > 0",
});

export const GetCookiesCommandSchema = type({ _tag: "'GetCookies'" });

export const NewTabCommandSchema = type({
  _tag: "'NewTab'",
  "url?": /^https?:\/\/.+/,
});

export const SwitchTabCommandSchema = type({
  _tag: "'SwitchTab'",
  tabName: "string > 0",
});

export const CloseTabCommandSchema = type({
  _tag: "'CloseTab'",
  tabName: "string > 0",
});

export const BrowserCommandSchema = NavigateCommandSchema
  .or(ClickCommandSchema)
  .or(FillCommandSchema)
  .or(SnapshotCommandSchema)
  .or(ScreenshotCommandSchema)
  .or(WaitCommandSchema)
  .or(EvaluateCommandSchema)
  .or(GetCookiesCommandSchema)
  .or(NewTabCommandSchema)
  .or(SwitchTabCommandSchema)
  .or(CloseTabCommandSchema);

// ---- Client Event Schemas ----

export const RegisterEventSchema = type({
  _tag: "'Register'",
  agentId: slugPattern,
  profile: slugPattern,
  token: "string > 0",
  "instance?": "string",
});

export const DeregisterEventSchema = type({
  _tag: "'Deregister'",
  sessionId: "string > 0",
});

export const CommandEventSchema = type({
  _tag: "'Command'",
  sessionId: "string > 0",
  command: BrowserCommandSchema,
});

export const StartUserChromeEventSchema = type({
  _tag: "'StartUserChrome'",
  profileName: slugPattern,
});

export const StopUserChromeEventSchema = type({ _tag: "'StopUserChrome'" });

export const FreezeProfileEventSchema = type({
  _tag: "'FreezeProfile'",
  profileName: slugPattern,
});

export const ListProfilesEventSchema = type({ _tag: "'ListProfiles'" });
export const PingEventSchema = type({ _tag: "'Ping'" });

export const ClientEventSchema = RegisterEventSchema
  .or(DeregisterEventSchema)
  .or(CommandEventSchema)
  .or(StartUserChromeEventSchema)
  .or(StopUserChromeEventSchema)
  .or(FreezeProfileEventSchema)
  .or(ListProfilesEventSchema)
  .or(PingEventSchema);
