import type { RefStaleReason as RefStaleReasonType } from "@moat-browser/types";
import type { Frame, Locator, Page } from "patchright";

export type RefStaleReason = RefStaleReasonType;

// ─── RefStore ───

export type RefScope = {
  readonly page: Page;
  readonly frame?: Frame;
  readonly navigationGeneration: number;
};

export type RefResolution =
  | { readonly _tag: "Found"; readonly locator: Locator }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Stale"; readonly reason: RefStaleReason };

type RefSnapshot = {
  readonly refs: Map<string, Locator>;
  readonly scope?: RefScope;
  readonly generation: number;
};

type StaleRef = {
  readonly reason: RefStaleReason;
  readonly generation: number;
};

type SessionRefs = {
  current?: RefSnapshot;
  readonly stale: Map<string, StaleRef>;
  staleSnapshotBeforeRefNumber?: number;
  generation: number;
};

export type RefStore = {
  /** snapshot 时调用，清空旧引用，存入新引用 */
  update(sessionId: string, refs: Map<string, Locator>, scope?: RefScope): void;
  /** 命令执行时调用，根据 @eN 返回 Locator */
  resolve(sessionId: string, ref: string, scope?: RefScope): Locator | undefined;
  /** 返回引用的生命周期状态，供 controller 生成可操作的错误 */
  resolveDetailed(sessionId: string, ref: string, scope?: RefScope): RefResolution;
  /** 主动使当前 session 的引用失效，并保留失效原因 */
  invalidate(sessionId: string, reason: RefStaleReason): void;
  /** 会话终止时删除所有引用和失效记录 */
  clear(sessionId: string): void;
  /** screenshot annotation 时枚举当前 session 的引用 */
  entries(sessionId: string): ReadonlyArray<readonly [string, Locator]>;
};

function scopeStaleReason(previous: RefScope | undefined, current: RefScope | undefined): RefStaleReason | undefined {
  if (!previous || !current) return undefined;
  if (previous.page !== current.page) return "page";
  if (previous.frame !== current.frame) return "frame";
  if (previous.navigationGeneration !== current.navigationGeneration) return "navigation";
  return undefined;
}

const MAX_STALE_GENERATIONS = 8;
const MAX_STALE_REFS = 1024;
const SNAPSHOT_REF_RE = /^@e(\d+)$/;

function snapshotRefNumber(ref: string): number | undefined {
  const match = SNAPSHOT_REF_RE.exec(ref);
  if (!match) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : undefined;
}

export function createRefStore(): RefStore {
  const store = new Map<string, SessionRefs>();

  function sessionRefs(sessionId: string): SessionRefs {
    const existing = store.get(sessionId);
    if (existing) return existing;
    const created: SessionRefs = { stale: new Map(), generation: 0 };
    store.set(sessionId, created);
    return created;
  }

  function rememberStale(
    session: SessionRefs,
    refs: Iterable<string>,
    reason: RefStaleReason,
    generation: number,
  ): void {
    for (const ref of refs) {
      session.stale.set(ref, { reason, generation });
    }
  }

  function pruneStale(session: SessionRefs): void {
    const oldestRetainedGeneration = session.generation - MAX_STALE_GENERATIONS + 1;
    for (const [ref, stale] of session.stale) {
      if (stale.generation >= oldestRetainedGeneration) continue;
      const number = snapshotRefNumber(ref);
      if (number !== undefined) {
        session.staleSnapshotBeforeRefNumber = Math.max(
          session.staleSnapshotBeforeRefNumber ?? number,
          number,
        );
      }
      session.stale.delete(ref);
    }

    if (session.stale.size <= MAX_STALE_REFS) return;
    for (const [ref] of session.stale) {
      if (session.stale.size <= MAX_STALE_REFS) break;
      const number = snapshotRefNumber(ref);
      if (number !== undefined) {
        session.staleSnapshotBeforeRefNumber = Math.max(
          session.staleSnapshotBeforeRefNumber ?? number,
          number,
        );
      }
      session.stale.delete(ref);
    }
  }

  function resolveDetailed(sessionId: string, ref: string, scope?: RefScope): RefResolution {
    const refs = store.get(sessionId);
    if (!refs) return { _tag: "Missing" };

    const current = refs.current;
    if (current) {
      const locator = current.refs.get(ref);
      if (locator) {
        const reason = scopeStaleReason(current.scope, scope);
        if (reason) return { _tag: "Stale", reason };
        return { _tag: "Found", locator };
      }
    }

    const stale = refs.stale.get(ref);
    if (stale) return { _tag: "Stale", reason: stale.reason };

    const number = snapshotRefNumber(ref);
    if (
      number !== undefined
      && refs.staleSnapshotBeforeRefNumber !== undefined
      && number <= refs.staleSnapshotBeforeRefNumber
    ) {
      return { _tag: "Stale", reason: "snapshot" };
    }
    return { _tag: "Missing" };
  }

  return {
    update(sessionId, refs, scope) {
      const session = sessionRefs(sessionId);
      const generation = session.generation + 1;
      session.generation = generation;
      const current = session.current;
      if (current) rememberStale(session, current.refs.keys(), "snapshot", current.generation);
      session.current = {
        refs: new Map(refs),
        generation,
        ...(scope === undefined ? {} : { scope }),
      };
      pruneStale(session);
    },

    resolve(sessionId, ref, scope) {
      const result = resolveDetailed(sessionId, ref, scope);
      return result._tag === "Found" ? result.locator : undefined;
    },

    resolveDetailed,

    invalidate(sessionId, reason) {
      const session = store.get(sessionId);
      if (!session) return;
      const current = session.current;
      if (current) rememberStale(session, current.refs.keys(), reason, current.generation);
      session.current = {
        refs: new Map(),
        generation: session.generation,
      };
      pruneStale(session);
    },

    clear(sessionId) {
      store.delete(sessionId);
    },

    entries(sessionId) {
      return Array.from(store.get(sessionId)?.current?.refs.entries() ?? []);
    },
  };
}
