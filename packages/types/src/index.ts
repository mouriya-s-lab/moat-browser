export { exhaustive } from "./exhaustive.js";

export type {
  ContainerInfo,
  ProfileInfo,
  HealthInfo,
  UserChromeState,
  AgentChromeState,
} from "./container.js";

export type {
  ControllerRequest,
  ControllerResult,
  ControllerError,
} from "./controller.js";

export {
  ContainerInfoSchema,
  ProfileInfoSchema,
  HealthInfoSchema,
  CreateAgentBrowserSchema,
  DestroyAgentBrowserSchema,
  GetAgentBrowserSchema,
  ListAgentBrowsersSchema,
  StartUserChromeSchema,
  StopUserChromeSchema,
  FreezeProfileSchema,
  ListProfilesSchema,
  DeleteProfileSchema,
  HealthCheckSchema,
  ControllerRequestSchema,
} from "./schemas.js";

export type {
  CookieInfo,
  BrowserCommand,
  BrowserResult,
  ClientEvent,
  ServerEvent,
  GatewayError,
} from "./messages.js";

export {
  BrowserCommandSchema,
  NavigateCommandSchema,
  ClickCommandSchema,
  FillCommandSchema,
  SnapshotCommandSchema,
  ScreenshotCommandSchema,
  WaitCommandSchema,
  EvaluateCommandSchema,
  GetCookiesCommandSchema,
  NewTabCommandSchema,
  SwitchTabCommandSchema,
  CloseTabCommandSchema,
  RegisterEventSchema,
  DeregisterEventSchema,
  CommandEventSchema,
  StartUserChromeEventSchema,
  StopUserChromeEventSchema,
  FreezeProfileEventSchema,
  ListProfilesEventSchema,
  PingEventSchema,
  ClientEventSchema,
} from "./message-schemas.js";

export type {
  FrozenMeta,
  ProfileState,
  ProfileAction,
  ProfileResult,
  ProfileError,
  CopyStrategy,
} from "./profile.js";

export {
  FrozenMetaSchema,
  validateProfileAction,
} from "./profile.js";

export type {
  ExpireReason,
  SessionState,
  SessionEvent,
  TokenPayload,
  TokenResult,
  RegistryResult,
} from "./registration.js";

export {
  transitionSession,
  TokenPayloadSchema,
} from "./registration.js";
