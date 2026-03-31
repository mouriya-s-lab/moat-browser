import type { GatewayError } from "@moat-browser/types";

type BudgetEntry = {
  count: number;
  resetAt: number;
};

const budgets = new Map<string, BudgetEntry>();

const DEFAULT_MAX = Number(process.env["MOAT_BUDGET_MAX"] ?? 1000);
const WINDOW_MS = Number(process.env["MOAT_BUDGET_WINDOW_MS"] ?? 3600_000); // 1 hour

export function checkBudget(sessionId: string): GatewayError | null {
  if (DEFAULT_MAX <= 0) return null; // Disabled

  const now = Date.now();
  let entry = budgets.get(sessionId);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    budgets.set(sessionId, entry);
  }

  entry.count++;

  if (entry.count > DEFAULT_MAX) {
    return {
      _tag: "BudgetExceeded",
      limit: `${DEFAULT_MAX} commands per ${WINDOW_MS / 1000}s`,
      current: entry.count,
      max: DEFAULT_MAX,
    };
  }

  return null;
}

export function clearBudget(sessionId: string): void {
  budgets.delete(sessionId);
}
