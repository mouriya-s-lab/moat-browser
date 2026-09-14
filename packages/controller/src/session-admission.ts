import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ControllerError } from "@moat-browser/types";

// ─── Result ADT ───

export type Result<T, E> =
  | { readonly _tag: "Ok"; readonly value: T }
  | { readonly _tag: "Err"; readonly error: E };

function Ok<T>(value: T): Result<T, never> {
  return { _tag: "Ok", value };
}

function Err<E>(error: E): Result<never, E> {
  return { _tag: "Err", error };
}

// ─── Admission model ───

export type AdmissionPhase =
  | "registering"
  | "creating"
  | "connecting"
  | "active"
  | "cleanup";

export type ExternalAllocation = {
  readonly sessionId: string | undefined;
  readonly owner: string | undefined;
};

type AllocationRecord = {
  readonly sessionId: string;
  readonly owner: string;
  readonly ownerQuota: number;
  readonly phase: AdmissionPhase;
  readonly reservedAt: number;
};

type SlotRecord = {
  readonly slot: number;
  readonly allocation: AllocationRecord | undefined;
};

export type AdmissionSnapshot = {
  readonly current: number;
  readonly limit: number;
  readonly owner: string;
  readonly ownerCurrent: number;
  readonly ownerLimit: number;
};

export type SessionAdmissionConfig = {
  readonly owner: string;
  readonly ownerQuota: number;
  readonly totalQuota: number;
  /** Shared directory mounted by every controller using the same daemon. */
  readonly statePath?: string;
  /** Read-only Docker inventory used to account for resources created before restart. */
  readonly listExternalAllocations?: () => Promise<
    Result<ReadonlyArray<ExternalAllocation>, ControllerError>
  >;
  /** Optional complete static owner declaration, e.g. owner-a=3,owner-b=2. */
  readonly ownerQuotas?: Readonly<Record<string, number>>;
};

export type SessionAdmission = {
  reserve(): Promise<Result<{ readonly sessionId: string }, ControllerError>>;
  updatePhase(sessionId: string, phase: AdmissionPhase): Promise<Result<void, ControllerError>>;
  release(sessionId: string): Promise<Result<void, ControllerError>>;
  snapshot(): Promise<Result<AdmissionSnapshot, ControllerError>>;
  reconcile(): Promise<Result<{ readonly removed: number }, ControllerError>>;
};

const MAX_TOTAL_QUOTA = 5;
const LOCK_WAIT_MS = 900;
const LOCK_STALE_MS = 1_000;
const LOCK_RETRY_MS = 5;

export function createSessionAdmission(config: SessionAdmissionConfig): SessionAdmission {
  const configError = validateConfig(config);
  const memoryAllocations = new Map<string, AllocationRecord>();
  return {
    reserve,
    updatePhase,
    release,
    snapshot,
    reconcile,
  };

  async function reserve(): Promise<Result<{ readonly sessionId: string }, ControllerError>> {
    if (configError) return Err(configError);
    const sessionId = randomUUID();
    return withStateLock(async () => {
      const inventory = await readInventory();
      if (inventory._tag === "Err") return inventory;
      const preliminaryCounts = countAllocations(inventory.value, [], config.owner);
      if (
        preliminaryCounts.current >= config.totalQuota ||
        preliminaryCounts.ownerCurrent >= config.ownerQuota
      ) {
        return Err(capacityError(preliminaryCounts.current, preliminaryCounts.ownerCurrent));
      }

      const external = await readExternalAllocations();
      if (external._tag === "Err") return external;
      const counts = countAllocations(inventory.value, external.value, config.owner);
      const ownerDeclaration = validateOwnerDeclarations(inventory.value, external.value, config);
      if (ownerDeclaration._tag === "Err") return ownerDeclaration;

      if (counts.current >= config.totalQuota || counts.ownerCurrent >= config.ownerQuota) {
        return Err(capacityError(counts.current, counts.ownerCurrent));
      }

      const slot = firstFreeSlot(inventory.value, config.totalQuota);
      if (slot === undefined) {
        return Err(capacityError(counts.current, counts.ownerCurrent));
      }

      const allocation: AllocationRecord = {
        sessionId,
        owner: config.owner,
        ownerQuota: config.ownerQuota,
        phase: "registering",
        reservedAt: Date.now(),
      };

      if (config.statePath) {
        const slotPath = join(config.statePath, `slot-${slot}`);
        try {
          await mkdir(slotPath);
          await writeFile(join(slotPath, "allocation.json"), JSON.stringify(allocation), {
            encoding: "utf8",
            flag: "wx",
          });
        } catch (error) {
          await rm(slotPath, { recursive: true, force: true }).catch(() => undefined);
          return Err({
            _tag: "CommandFailed",
            message: `Admission reservation failed before resource creation: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      } else {
        memoryAllocations.set(sessionId, allocation);
      }

      return Ok({ sessionId });
    });
  }

  async function updatePhase(
    sessionId: string,
    phase: AdmissionPhase,
  ): Promise<Result<void, ControllerError>> {
    if (configError) return Err(configError);
    return withStateLock(async () => {
      if (!config.statePath) {
        const allocation = memoryAllocations.get(sessionId);
        if (!allocation) return Err({ _tag: "SessionNotFound", sessionId });
        memoryAllocations.set(sessionId, { ...allocation, phase });
        return Ok(undefined);
      }

      const inventory = await readInventory();
      if (inventory._tag === "Err") return inventory;
      const slot = inventory.value.find(
        (record) => record.allocation?.sessionId === sessionId,
      );
      if (!slot?.allocation) return Err({ _tag: "SessionNotFound", sessionId });

      const updated: AllocationRecord = { ...slot.allocation, phase };
      try {
        await writeFile(
          join(config.statePath, `slot-${slot.slot}`, "allocation.json"),
          JSON.stringify(updated),
          "utf8",
        );
      } catch (error) {
        return Err({
          _tag: "CommandFailed",
          message: `Admission phase update failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return Ok(undefined);
    });
  }

  async function release(sessionId: string): Promise<Result<void, ControllerError>> {
    if (configError) return Err(configError);
    return withStateLock(async () => {
      const external = await readExternalAllocations();
      if (external._tag === "Err") return external;
      if (external.value.some((allocation) => allocation.sessionId === sessionId)) {
        return Err({
          _tag: "CommandFailed",
          message: `Admission allocation for session ${sessionId} remains in Docker; retry release after cleanup reaches a terminal state`,
        });
      }

      if (!config.statePath) {
        memoryAllocations.delete(sessionId);
        return Ok(undefined);
      }

      const inventory = await readInventory();
      if (inventory._tag === "Err") return inventory;
      const slot = inventory.value.find(
        (record) => record.allocation?.sessionId === sessionId,
      );
      if (!slot) return Ok(undefined);
      try {
        await rm(join(config.statePath, `slot-${slot.slot}`), {
          recursive: true,
          force: true,
        });
      } catch (error) {
        return Err({
          _tag: "CommandFailed",
          message: `Admission release failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return Ok(undefined);
    });
  }

  async function snapshot(): Promise<Result<AdmissionSnapshot, ControllerError>> {
    if (configError) return Err(configError);
    return withStateLock(async () => {
      const inventory = await readInventory();
      if (inventory._tag === "Err") return inventory;
      const external = await readExternalAllocations();
      if (external._tag === "Err") return external;
      const counts = countAllocations(inventory.value, external.value, config.owner);
      return Ok({
        current: counts.current,
        limit: config.totalQuota,
        owner: config.owner,
        ownerCurrent: counts.ownerCurrent,
        ownerLimit: config.ownerQuota,
      });
    });
  }

  async function reconcile(): Promise<Result<{ readonly removed: number }, ControllerError>> {
    if (!config.statePath) {
      return Ok({ removed: 0 });
    }
    const statePath = config.statePath;
    return withStateLock(async () => {
      const inventory = await readInventory();
      if (inventory._tag === "Err") return inventory;
      const external = await readExternalAllocations();
      if (external._tag === "Err") return external;
      const externalSessions = new Set(
        external.value.flatMap((allocation) =>
          allocation.sessionId ? [allocation.sessionId] : [],
        ),
      );
      let removed = 0;
      for (const record of inventory.value) {
        if (
          record.allocation?.owner === config.owner &&
          !externalSessions.has(record.allocation.sessionId)
        ) {
          await rm(join(statePath, `slot-${record.slot}`), {
            recursive: true,
            force: true,
          });
          removed += 1;
        }
      }
      return Ok({ removed });
    });
  }

  async function withStateLock<T>(
    operation: () => Promise<Result<T, ControllerError>>,
  ): Promise<Result<T, ControllerError>> {
    if (!config.statePath) return operation();
    try {
      await mkdir(config.statePath, { recursive: true });
    } catch (error) {
      return Err({
        _tag: "CommandFailed",
        message: `Admission state directory unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const lockPath = join(config.statePath, ".lock");
    const acquired = await acquireLock(lockPath);
    if (acquired._tag === "Err") return acquired;
    const heartbeat = setInterval(() => {
      void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
    }, LOCK_RETRY_MS * 10);
    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function acquireLock(lockPath: string): Promise<Result<void, ControllerError>> {
    const started = Date.now();
    while (Date.now() - started < LOCK_WAIT_MS) {
      try {
        await mkdir(lockPath);
        await writeFile(
          join(lockPath, "owner"),
          `${process.pid}:${Date.now()}`,
          { encoding: "utf8", flag: "wx" },
        );
        return Ok(undefined);
      } catch (error) {
        const code = isNodeError(error) ? error.code : undefined;
        if (code !== "EEXIST") {
          return Err({
            _tag: "CommandFailed",
            message: `Admission lock failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }

        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          // A competing owner released the lock; retry immediately.
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    return Err({
      _tag: "CommandFailed",
      message: "Admission lock is busy; retry the request without creating a session",
    });
  }

  async function readInventory(): Promise<Result<ReadonlyArray<SlotRecord>, ControllerError>> {
    if (!config.statePath) {
      return Ok(
        [...memoryAllocations.values()].map((allocation, slot) => ({ slot, allocation })),
      );
    }

    let entries: ReadonlyArray<Dirent>;
    try {
      entries = await readdir(config.statePath, { withFileTypes: true });
    } catch (error) {
      return Err({
        _tag: "CommandFailed",
        message: `Admission inventory unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const slots: SlotRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("slot-")) continue;
      const slot = Number(entry.name.slice("slot-".length));
      if (!Number.isInteger(slot) || slot < 0 || slot >= config.totalQuota) continue;
      let allocation: AllocationRecord | undefined;
      try {
        const raw = await readFile(join(config.statePath, entry.name, "allocation.json"), "utf8");
        allocation = parseAllocation(raw);
      } catch {
        // An unfinalized slot is deliberately counted as occupied. It is safer
        // to make an operator repair a stale marker than to over-allocate.
      }
      slots.push({ slot, allocation });
    }
    return Ok(slots);
  }

  async function readExternalAllocations(): Promise<Result<ReadonlyArray<ExternalAllocation>, ControllerError>> {
    if (!config.listExternalAllocations) return Ok([]);
    return config.listExternalAllocations();
  }

  function capacityError(current: number, ownerCurrent: number): ControllerError {
    return {
      _tag: "CapacityExceeded",
      owner: config.owner,
      current,
      limit: config.totalQuota,
      ownerCurrent,
      ownerLimit: config.ownerQuota,
      retryCondition: "retry after an existing session and its cleanup resources are fully gone",
    };
  }
}

function validateConfig(config: SessionAdmissionConfig): ControllerError | undefined {
  if (!Number.isInteger(config.totalQuota) || config.totalQuota < 1 || config.totalQuota > MAX_TOTAL_QUOTA) {
    return {
      _tag: "ValidationFailed",
      message: `SESSION_TOTAL_QUOTA must be an integer from 1 to ${MAX_TOTAL_QUOTA}`,
    };
  }
  if (!Number.isInteger(config.ownerQuota) || config.ownerQuota < 1 || config.ownerQuota > config.totalQuota) {
    return {
      _tag: "ValidationFailed",
      message: "SESSION_QUOTA must be an integer from 1 through SESSION_TOTAL_QUOTA",
    };
  }
  if (config.ownerQuotas) {
    const declared = Object.entries(config.ownerQuotas);
    for (const [owner, quota] of declared) {
      if (
        owner.length === 0 ||
        !Number.isInteger(quota) ||
        quota < 1 ||
        quota > config.totalQuota
      ) {
        return {
          _tag: "ValidationFailed",
          message: "SESSION_OWNER_QUOTAS must contain positive integer quotas within the shared limit",
        };
      }
    }
    const sum = declared.reduce((total, [, quota]) => total + quota, 0);
    if (sum > config.totalQuota) {
      return {
        _tag: "ValidationFailed",
        message: `SESSION_OWNER_QUOTAS sum ${sum} exceeds shared quota ${config.totalQuota}`,
      };
    }
    if (config.ownerQuotas[config.owner] !== config.ownerQuota) {
      return {
        _tag: "ValidationFailed",
        message: `SESSION_OWNER_QUOTAS must declare ${config.owner}=${config.ownerQuota}`,
      };
    }
  }
  return undefined;
}

function validateOwnerDeclarations(
  inventory: ReadonlyArray<SlotRecord>,
  external: ReadonlyArray<ExternalAllocation>,
  config: SessionAdmissionConfig,
): Result<void, ControllerError> {
  const declarations = new Map<string, number>();
  if (config.ownerQuotas) {
    for (const [owner, quota] of Object.entries(config.ownerQuotas)) {
      declarations.set(owner, quota);
    }
  }
  for (const record of inventory) {
    const allocation = record.allocation;
    if (!allocation) continue;
    const previous = declarations.get(allocation.owner);
    if (previous !== undefined && previous !== allocation.ownerQuota) {
      return Err({
        _tag: "ValidationFailed",
        message: `conflicting static quota declarations for owner ${allocation.owner}`,
      });
    }
    declarations.set(allocation.owner, allocation.ownerQuota);
  }
  for (const allocation of external) {
    if (!allocation.owner || allocation.owner === config.owner) continue;
    if (!declarations.has(allocation.owner)) {
      return Err({
        _tag: "ValidationFailed",
        message: `cannot admit while owner ${allocation.owner} has no declared static quota`,
      });
    }
  }
  if (!declarations.has(config.owner)) {
    declarations.set(config.owner, config.ownerQuota);
  }
  const declaredTotal = [...declarations.values()].reduce((total, quota) => total + quota, 0);
  if (declaredTotal > config.totalQuota) {
    return Err({
      _tag: "ValidationFailed",
      message: `declared owner quotas sum ${declaredTotal} exceeds shared quota ${config.totalQuota}`,
    });
  }
  return Ok(undefined);
}

function countAllocations(
  inventory: ReadonlyArray<SlotRecord>,
  external: ReadonlyArray<ExternalAllocation>,
  owner: string,
): { readonly current: number; readonly ownerCurrent: number } {
  const sessions = new Set<string>();
  const ownerSessions = new Set<string>();

  for (const record of inventory) {
    if (record.allocation) {
      sessions.add(record.allocation.sessionId);
      if (record.allocation.owner === owner) {
        ownerSessions.add(record.allocation.sessionId);
      }
    } else {
      sessions.add(`unknown-slot-${record.slot}`);
    }
  }

  for (const allocation of external) {
    const key = allocation.sessionId ?? `unknown-docker-${sessions.size}`;
    sessions.add(key);
    if (allocation.owner === owner) ownerSessions.add(key);
  }

  return { current: sessions.size, ownerCurrent: ownerSessions.size };
}

function firstFreeSlot(
  inventory: ReadonlyArray<SlotRecord>,
  totalQuota: number,
): number | undefined {
  const occupied = new Set(inventory.map((record) => record.slot));
  for (let slot = 0; slot < totalQuota; slot += 1) {
    if (!occupied.has(slot)) return slot;
  }
  return undefined;
}

function parseAllocation(raw: string): AllocationRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const sessionId = value.sessionId;
  const owner = value.owner;
  const ownerQuota = value.ownerQuota;
  const phase = value.phase;
  const reservedAt = value.reservedAt;
  if (
    typeof sessionId !== "string" ||
    typeof owner !== "string" ||
    typeof ownerQuota !== "number" ||
    !Number.isInteger(ownerQuota) ||
    !isAdmissionPhase(phase) ||
    typeof reservedAt !== "number"
  ) {
    return undefined;
  }
  return { sessionId, owner, ownerQuota, phase, reservedAt };
}

function isAdmissionPhase(value: unknown): value is AdmissionPhase {
  return value === "registering" || value === "creating" || value === "connecting" || value === "active" || value === "cleanup";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
