import { describe, test, expect, beforeEach } from "bun:test";
import { checkBudget, clearBudget } from "../budget.js";

describe("Budget", () => {
  beforeEach(() => {
    clearBudget("test-session");
  });

  test("allows commands within budget", () => {
    const result = checkBudget("test-session");
    expect(result).toBeNull();
  });

  test("allows many commands up to limit", () => {
    // Default limit is 1000
    for (let i = 0; i < 999; i++) {
      expect(checkBudget("test-session")).toBeNull();
    }
  });

  test("tracks separate sessions independently", () => {
    for (let i = 0; i < 500; i++) {
      checkBudget("session-a");
    }
    // session-b should start fresh
    expect(checkBudget("session-b")).toBeNull();
    clearBudget("session-a");
    clearBudget("session-b");
  });

  test("clearBudget resets the counter", () => {
    for (let i = 0; i < 500; i++) {
      checkBudget("test-session");
    }
    clearBudget("test-session");
    expect(checkBudget("test-session")).toBeNull();
  });
});
