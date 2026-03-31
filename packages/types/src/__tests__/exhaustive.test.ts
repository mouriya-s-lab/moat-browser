import { describe, test, expect } from "bun:test";
import { exhaustive } from "../exhaustive.js";

describe("exhaustive", () => {
  test("throws on unexpected value", () => {
    expect(() => exhaustive("unexpected" as never)).toThrow("Unexpected value");
  });

  test("error message includes the value", () => {
    expect(() => exhaustive({ _tag: "Unknown" } as never)).toThrow(
      'Unexpected value: {"_tag":"Unknown"}'
    );
  });

  test("works in switch default branch", () => {
    type Action = { _tag: "A" } | { _tag: "B" };

    function handle(action: Action): string {
      switch (action._tag) {
        case "A":
          return "handled A";
        case "B":
          return "handled B";
        default:
          return exhaustive(action);
      }
    }

    expect(handle({ _tag: "A" })).toBe("handled A");
    expect(handle({ _tag: "B" })).toBe("handled B");
  });
});
