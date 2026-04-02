import { type } from "arktype";

// BrowserCommand schemas
const Navigate = type({ _tag: "'Navigate'", url: "string" });
const Click = type({ _tag: "'Click'", selector: "string" });
const Fill = type({ _tag: "'Fill'", selector: "string", value: "string" });
const Snapshot = type({ _tag: "'Snapshot'" });
const Screenshot = type({ _tag: "'Screenshot'" });
const Evaluate = type({ _tag: "'Evaluate'", expression: "string" });
const NewTab = type({ _tag: "'NewTab'", "url?": "string" });
const SwitchTab = type({ _tag: "'SwitchTab'", index: "number" });
const CloseTab = type({ _tag: "'CloseTab'", index: "number" });
const Wait = type({ _tag: "'Wait'", selector: "string", "timeout?": "number" });

export const BrowserCommandSchema = Navigate.or(Click).or(Fill).or(Snapshot).or(Screenshot).or(Evaluate).or(NewTab).or(SwitchTab).or(CloseTab).or(Wait);

// BrowserResult schemas
const NavigateResult = type({ _tag: "'NavigateResult'", url: "string", title: "string" });
const ClickResult = type({ _tag: "'ClickResult'" });
const FillResult = type({ _tag: "'FillResult'" });
const SnapshotResult = type({ _tag: "'SnapshotResult'", aria: "string" });
const ScreenshotResult = type({ _tag: "'ScreenshotResult'", png: "string" });
const EvaluateResult = type({ _tag: "'EvaluateResult'", value: "unknown" });
const TabInfo = type({ index: "number", url: "string", title: "string" });
const TabResult = type({ _tag: "'TabResult'", tabs: TabInfo.array() });
const WaitResult = type({ _tag: "'WaitResult'" });

export const BrowserResultSchema = NavigateResult.or(ClickResult).or(FillResult).or(SnapshotResult).or(ScreenshotResult).or(EvaluateResult).or(TabResult).or(WaitResult);

// GatewayError schemas
const AuthError = type({ _tag: "'AuthError'", message: "string" });
const SessionNotFound = type({ _tag: "'SessionNotFound'", sessionId: "string" });
const SessionExpired = type({ _tag: "'SessionExpired'", sessionId: "string" });
const CommandError = type({ _tag: "'CommandError'", command: "string", message: "string" });
const ContainerError = type({ _tag: "'ContainerError'", message: "string" });
const ValidationError = type({ _tag: "'ValidationError'", message: "string" });

export const GatewayErrorSchema = AuthError.or(SessionNotFound).or(SessionExpired).or(CommandError).or(ContainerError).or(ValidationError);
