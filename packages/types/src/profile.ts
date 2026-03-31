import { type } from "arktype";
import { exhaustive } from "./exhaustive.js";

// ---- Frozen metadata schema ----

export const FrozenMetaSchema = type({
  profileName: "string",
  frozenAt: "string",
  frozenBy: "string",
  chromiumVersion: "string",
  "domainsLoggedIn?": "string[]",
  sizeBytes: "number >= 0",
  "checksum?": /^sha256:[a-f0-9]{64}$/,
});

export type FrozenMeta = typeof FrozenMetaSchema.infer;

// ---- Profile State ADT ----

export type ProfileState =
  | { readonly _tag: "Empty"; readonly name: string }
  | { readonly _tag: "InUse"; readonly name: string; readonly containerId: string }
  | { readonly _tag: "Frozen"; readonly name: string; readonly meta: FrozenMeta }
  | { readonly _tag: "Archived"; readonly name: string; readonly archivedAt: string };

// ---- Profile Action ADT ----

export type ProfileAction =
  | { readonly _tag: "Create"; readonly name: string }
  | { readonly _tag: "MarkInUse"; readonly name: string; readonly containerId: string }
  | { readonly _tag: "Freeze"; readonly name: string }
  | { readonly _tag: "Thaw"; readonly name: string }
  | { readonly _tag: "CopyForAgent"; readonly name: string; readonly agentId: string }
  | { readonly _tag: "CleanLive"; readonly agentId: string }
  | { readonly _tag: "Archive"; readonly name: string }
  | { readonly _tag: "Delete"; readonly name: string };

// ---- Profile Result ADT ----

export type ProfileResult =
  | { readonly _tag: "Created"; readonly path: string }
  | { readonly _tag: "MarkedInUse" }
  | { readonly _tag: "ProfileFrozen"; readonly meta: FrozenMeta }
  | { readonly _tag: "Thawed" }
  | { readonly _tag: "Copied"; readonly livePath: string }
  | { readonly _tag: "Cleaned"; readonly agentId: string }
  | { readonly _tag: "ProfileArchived"; readonly archivePath: string }
  | { readonly _tag: "Deleted" };

// ---- Profile Error ADT ----

export type ProfileError =
  | { readonly _tag: "NotFound"; readonly name: string }
  | { readonly _tag: "NotFrozen"; readonly name: string }
  | { readonly _tag: "AlreadyFrozen"; readonly name: string }
  | { readonly _tag: "StillInUse"; readonly name: string; readonly containerId: string }
  | { readonly _tag: "CopyFailed"; readonly reason: string }
  | { readonly _tag: "IntegrityCheckFailed"; readonly details: string }
  | { readonly _tag: "ChromiumVersionMismatch"; readonly frozen: string; readonly current: string }
  | { readonly _tag: "IoError"; readonly message: string };

// ---- COW Copy Strategy ADT ----

export type CopyStrategy =
  | { readonly _tag: "Reflink" }
  | { readonly _tag: "PlainCopy" };

// ---- State machine: validate action against current state ----

export function validateProfileAction(
  state: ProfileState,
  action: ProfileAction,
): ProfileError | null {
  switch (action._tag) {
    case "Create":
      return null; // Always allowed
    case "MarkInUse":
      switch (state._tag) {
        case "Empty": return null;
        case "InUse": return { _tag: "StillInUse", name: action.name, containerId: state.containerId };
        case "Frozen": return null;
        case "Archived": return { _tag: "NotFound", name: action.name };
        default: return exhaustive(state);
      }
    case "Freeze":
      switch (state._tag) {
        case "Empty": return { _tag: "NotFound", name: action.name };
        case "InUse": return null;
        case "Frozen": return { _tag: "AlreadyFrozen", name: action.name };
        case "Archived": return { _tag: "NotFound", name: action.name };
        default: return exhaustive(state);
      }
    case "Thaw":
      switch (state._tag) {
        case "Empty": return { _tag: "NotFound", name: action.name };
        case "InUse": return null; // Already thawed
        case "Frozen": return null;
        case "Archived": return { _tag: "NotFound", name: action.name };
        default: return exhaustive(state);
      }
    case "CopyForAgent":
      switch (state._tag) {
        case "Empty": return { _tag: "NotFound", name: action.name };
        case "InUse": return { _tag: "NotFrozen", name: action.name };
        case "Frozen": return null;
        case "Archived": return { _tag: "NotFound", name: action.name };
        default: return exhaustive(state);
      }
    case "CleanLive":
      return null; // Always allowed
    case "Archive":
      switch (state._tag) {
        case "Empty": return { _tag: "NotFound", name: action.name };
        case "InUse": return { _tag: "StillInUse", name: action.name, containerId: state.containerId };
        case "Frozen": return null;
        case "Archived": return null; // Idempotent
        default: return exhaustive(state);
      }
    case "Delete":
      switch (state._tag) {
        case "Empty": return { _tag: "NotFound", name: action.name };
        case "InUse": return { _tag: "StillInUse", name: action.name, containerId: state.containerId };
        case "Frozen": return null;
        case "Archived": return null;
        default: return exhaustive(state);
      }
    default:
      return exhaustive(action);
  }
}
