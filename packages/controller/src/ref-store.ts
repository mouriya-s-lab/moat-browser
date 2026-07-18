import type { Locator } from "patchright";

// ─── RefStore ───

export type RefStore = {
  /** snapshot 时调用，清空旧引用，存入新引用 */
  update(sessionId: string, refs: Map<string, Locator>): void;
  /** 命令执行时调用，根据 @eN 返回 Locator */
  resolve(sessionId: string, ref: string): Locator | undefined;
  /** screenshot annotation 时枚举当前 session 的引用 */
  entries(sessionId: string): ReadonlyArray<readonly [string, Locator]>;
};

export function createRefStore(): RefStore {
  const store = new Map<string, Map<string, Locator>>();

  return {
    update(sessionId, refs) {
      store.set(sessionId, new Map(refs));
    },

    resolve(sessionId, ref) {
      return store.get(sessionId)?.get(ref);
    },

    entries(sessionId) {
      return Array.from(store.get(sessionId)?.entries() ?? []);
    },
  };
}
