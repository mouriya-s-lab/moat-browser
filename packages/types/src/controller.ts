import type { ContainerInfo, ProfileInfo, HealthInfo } from "./container.js";

// ---- Controller Request ADT ----
export type ControllerRequest =
  | { readonly _tag: "CreateAgentBrowser"; readonly agentId: string; readonly profileName: string }
  | { readonly _tag: "DestroyAgentBrowser"; readonly agentId: string }
  | { readonly _tag: "GetAgentBrowser"; readonly agentId: string }
  | { readonly _tag: "ListAgentBrowsers" }
  | { readonly _tag: "StartUserChrome"; readonly profileName: string }
  | { readonly _tag: "StopUserChrome" }
  | { readonly _tag: "FreezeProfile"; readonly profileName: string }
  | { readonly _tag: "ListProfiles" }
  | { readonly _tag: "DeleteProfile"; readonly profileName: string }
  | { readonly _tag: "HealthCheck"; readonly agentId: string };

// ---- Controller Result ADT ----
export type ControllerResult =
  | { readonly _tag: "AgentBrowserCreated"; readonly containerId: string; readonly socketPath: string }
  | { readonly _tag: "AgentBrowserDestroyed"; readonly agentId: string }
  | { readonly _tag: "AgentBrowserInfo"; readonly info: ContainerInfo }
  | { readonly _tag: "AgentBrowserList"; readonly items: readonly ContainerInfo[] }
  | { readonly _tag: "UserChromeStarted"; readonly containerId: string; readonly nekoPort: number }
  | { readonly _tag: "UserChromeStopped" }
  | { readonly _tag: "ProfileFrozen"; readonly snapshotId: string; readonly frozenAt: string }
  | { readonly _tag: "ProfileList"; readonly profiles: readonly ProfileInfo[] }
  | { readonly _tag: "ProfileDeleted"; readonly profileName: string }
  | { readonly _tag: "HealthStatus"; readonly status: HealthInfo };

// ---- Controller Error ADT ----
export type ControllerError =
  | { readonly _tag: "ProfileNotFound"; readonly profileName: string }
  | { readonly _tag: "ProfileNotFrozen"; readonly profileName: string }
  | { readonly _tag: "AgentAlreadyExists"; readonly agentId: string }
  | { readonly _tag: "AgentNotFound"; readonly agentId: string }
  | { readonly _tag: "ContainerStartFailed"; readonly reason: string }
  | { readonly _tag: "ProfileCopyFailed"; readonly reason: string }
  | { readonly _tag: "ChromiumVersionMismatch"; readonly expected: string; readonly actual: string }
  | { readonly _tag: "DockerError"; readonly message: string };
