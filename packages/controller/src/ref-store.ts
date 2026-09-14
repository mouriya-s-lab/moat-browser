import type { RefStaleReason } from "@moat-browser/types";
import type { Frame, Locator, Page } from "patchright";

export type { RefStaleReason } from "@moat-browser/types";

// ─── RefStore ───

export type RefStaleReason = "snapshot" | "frame" | "page" | "navigation";

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
};

type SessionRefs = {
  current?: RefSnapshot;
  readonly stale: Map<string, RefStaleReason>;
};

export type RefStore = {
  /** snapshot 时调用，清空旧引用，存入新引用 */
  update(sessionId: string, refs: Map<string, Locator>, scope?: RefScope): void;
  /** 命令执行时调用，根据 @eN 返回 Locator */
  resolve(sessionId: string, ref: string, scope?: RefScope): Locator | undefined;
  /** 返回引用的生命周期状态，供 controller 生成可操作的错误 */
  resolveDetailed?: (sessionId: string, ref: string, scope?: RefScope) => RefResolution;
  /** 主动使当前 session 的引用失效，并保留失效原因 */
  invalidate?: (sessionId: string, reason: RefStaleReason) => void;
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

export function createRefStore(): RefStore {
  const store = new Map<string, SessionRefs>();

  function sessionRefs(sessionId: string): SessionRefs {
    const existing = store.get(sessionId);
    if (existing) return existing;
    const created: SessionRefs = { stale: new Map() };
    store.set(sessionId, created);
    return created;
  }

  function resolveDetailed(sessionId: string, ref: string, scope?: RefScope): RefResolution {
    const refs = store.get(sessionId);
    if (!refs) return { _tag: "Missing" };

    const current = refs.current;
    const locator = current?.refs.get(ref);
    if (locator) {
      const reason = scopeStaleReason(current.scope, scope);
      if (reason) return { _tag: "Stale", reason };
      return { _tag: "Found", locator };
    }

    const reason = refs.stale.get(ref);
    return reason === undefined ? { _tag: "Missing" } : { _tag: "Stale", reason };
  }

  return {
    update(sessionId, refs, scope) {
      const session = sessionRefs(sessionId);
      for (const ref of session.current?.refs.keys() ?? []) {
        session.stale.set(ref, "snapshot");
      }
      session.current = { refs: new Map(refs), ...(scope === undefined ? {} : { scope }) };
    },

    resolve(sessionId, ref, scope) {
      const result = resolveDetailed(sessionId, ref, scope);
      return result._tag === "Found" ? result.locator : undefined;
    },

    resolveDetailed,

    invalidate(sessionId, reason) {
      const session = sessionRefs(sessionId);
      for (const ref of session.current?.refs.keys() ?? []) {
        session.stale.set(ref, reason);
      }
      session.current = { refs: new Map() };
    },

    entries(sessionId) {
      return Array.from(store.get(sessionId)?.current?.refs.entries() ?? []);
    },
  };
}
