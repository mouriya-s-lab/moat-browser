import { describe, test, expect, beforeAll } from "bun:test";
import { composePs, composeExec } from "./helpers";
import { ensureEnvironment } from "./setup";

describe("Phase 2: user-chrome image", () => {
  beforeAll(async () => {
    await ensureEnvironment();
  });

  test("user-chrome container is running", async () => {
    const ps = await composePs();
    expect(ps).toContain("user-chrome");
    expect(ps).toContain("running");
  });

  test("neko HTTP server responds", async () => {
    const { stdout, exitCode } = await composeExec("user-chrome", [
      "curl",
      "-sf",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "http://localhost:8080/",
    ]);
    expect(exitCode).toBe(0);
    // neko serves HTTP on 8080 inside the container
    expect(["200", "302"]).toContain(stdout);
  });

  test("profile directory exists with correct ownership", async () => {
    const { stdout, exitCode } = await composeExec("user-chrome", [
      "stat",
      "-c",
      "%U",
      "/data/profile",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("neko");
  });
});
