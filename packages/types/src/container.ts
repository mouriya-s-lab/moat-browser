// Container state ADTs

export type ContainerInfo = {
  readonly containerId: string;
  readonly agentId: string;
  readonly profileName: string;
  readonly state: "creating" | "running" | "stopping" | "destroyed";
  readonly createdAt: string;
  readonly socketPath?: string;
};

export type ProfileInfo = {
  readonly name: string;
  readonly frozen: boolean;
  readonly frozenAt?: string;
  readonly chromiumVersion?: string;
  readonly sizeBytes: number;
};

export type HealthInfo = {
  readonly agentId: string;
  readonly containerId: string;
  readonly cdpResponding: boolean;
  readonly socketResponding: boolean;
  readonly uptimeSeconds: number;
};

// User Chrome lifecycle states
export type UserChromeState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Starting"; readonly profileName: string }
  | { readonly _tag: "Running"; readonly containerId: string; readonly nekoPort: number }
  | { readonly _tag: "Freezing"; readonly containerId: string }
  | { readonly _tag: "Stopped" };

// Agent Chrome lifecycle states
export type AgentChromeState =
  | { readonly _tag: "Creating"; readonly agentId: string; readonly profileName: string }
  | { readonly _tag: "CopyingProfile"; readonly agentId: string; readonly src: string; readonly dst: string }
  | { readonly _tag: "Starting"; readonly agentId: string; readonly containerId: string }
  | { readonly _tag: "Ready"; readonly agentId: string; readonly containerId: string; readonly socketPath: string }
  | { readonly _tag: "Running"; readonly agentId: string; readonly containerId: string }
  | { readonly _tag: "Stopping"; readonly agentId: string; readonly containerId: string }
  | { readonly _tag: "Destroyed" };
