import { type } from "arktype";

// ---- Data schemas ----

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
