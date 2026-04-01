/**
 * browser.test.ts — Scenario group B: browser operations
 *
 * IMPORTANT: All B-group tests MUST pass by actually executing browser operations.
 * CommandError is NOT acceptable as a "passing" result.
 * If a browser operation fails, the test MUST fail.
 * Do NOT write resilient/tolerant tests that accept errors here.
 *
 * B1: navigate → snapshot → verify ARIA tree contains page content
 * B2: click → fill → submit (form flow)
 * B3: screenshot → returns base64 PNG
 * B4: multi-tab operations
 * B5: JavaScript evaluate
 *
 * All tests require Docker Compose stack to be running.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  waitForPort,
  createTestClient,
  assertResult,
  assertNotCommandError,
  TEST_WEBAPP_URL,
} from "./helpers.js";
import type { MoatBrowserClient } from "@moat-browser/shim";

const CONTROLLER_PORT = 9800;
const INFRASTRUCTURE_TIMEOUT = 60_000;

describe("Phase 9 - Scenario B: Browser Operations", () => {
  let client: MoatBrowserClient;

  beforeAll(async () => {
    await waitForPort(CONTROLLER_PORT, { timeout: INFRASTRUCTURE_TIMEOUT });

    client = await createTestClient();
    const reg = await client.connect();
    if ("_tag" in reg) {
      throw new Error(`B group setup: connect() failed: ${JSON.stringify(reg)}`);
    }

    // Navigate to homepage first
    const nav = await client.navigate(`${TEST_WEBAPP_URL}/`);
    assertNotCommandError(nav, "B setup navigate");
    assertResult(nav, "NavigateResult");
  }, INFRASTRUCTURE_TIMEOUT + 30_000);

  afterAll(async () => {
    await client.disconnect();
  });

  /**
   * B1: navigate returns NavigateResult with url and title
   */
  test("B1: navigate returns NavigateResult with url and title", async () => {
    const nav = await client.navigate(`${TEST_WEBAPP_URL}/`);

    // MUST NOT be CommandError
    assertNotCommandError(nav, "B1 navigate");
    assertResult(nav, "NavigateResult");

    expect(nav.url).toContain("8888");
    expect(typeof nav.title).toBe("string");
    expect(nav.title.length).toBeGreaterThan(0);
  }, 30_000);

  test("B1: snapshot returns ARIA tree with page content", async () => {
    await client.navigate(`${TEST_WEBAPP_URL}/`);

    const snap = await client.snapshot();

    // MUST NOT be CommandError
    assertNotCommandError(snap, "B1 snapshot");
    assertResult(snap, "SnapshotResult");

    // ARIA tree must contain actual page content — not an empty string
    expect(snap.snapshot.length).toBeGreaterThan(100);

    // The test homepage should have recognizable content
    expect(snap.snapshot).toContain("Moat Browser");
  }, 30_000);

  /**
   * B2: fill form field
   */
  test("B2: fill form field", async () => {
    await client.navigate(`${TEST_WEBAPP_URL}/form.html`);

    // Fill the email input
    const fill = await client.fill("#email", "test@example.com");

    // MUST NOT be CommandError
    assertNotCommandError(fill, "B2 fill");
    assertResult(fill, "FillResult");
  }, 30_000);

  test("B2: click button", async () => {
    await client.navigate(`${TEST_WEBAPP_URL}/form.html`);

    // Click the submit button
    const click = await client.click("#submit-btn");

    // MUST NOT be CommandError
    assertNotCommandError(click, "B2 click");
    assertResult(click, "ClickResult");
  }, 30_000);

  test("B2: fill then submit — full form flow", async () => {
    await client.navigate(`${TEST_WEBAPP_URL}/form.html`);

    // Fill username
    const fillUser = await client.fill("#username", "testuser");
    assertNotCommandError(fillUser, "B2 fill username");
    assertResult(fillUser, "FillResult");

    // Fill email
    const fillEmail = await client.fill("#email", "testuser@example.com");
    assertNotCommandError(fillEmail, "B2 fill email");
    assertResult(fillEmail, "FillResult");

    // Submit
    const click = await client.click("#submit-btn");
    assertNotCommandError(click, "B2 submit click");
    assertResult(click, "ClickResult");

    // Verify submission result appeared
    const snap = await client.snapshot();
    assertNotCommandError(snap, "B2 snapshot after submit");
    assertResult(snap, "SnapshotResult");
    expect(snap.snapshot).toContain("testuser@example.com");
  }, 60_000);

  /**
   * B3: screenshot → returns base64 PNG
   */
  test("B3: screenshot returns base64 PNG data URL", async () => {
    await client.navigate(`${TEST_WEBAPP_URL}/`);

    const screenshot = await client.screenshot();

    // MUST NOT be CommandError
    assertNotCommandError(screenshot, "B3 screenshot");
    assertResult(screenshot, "ScreenshotResult");

    // Must be a valid base64 data URL
    expect(screenshot.dataUrl).toMatch(/^data:image\/png;base64,/);

    // Must have actual image data (not empty)
    const base64 = screenshot.dataUrl.replace(/^data:image\/png;base64,/, "");
    expect(base64.length).toBeGreaterThan(1000); // A real screenshot is large
  }, 30_000);

  /**
   * B4: multi-tab operations
   */
  test("B4: open new tab and switch between tabs", async () => {
    await client.navigate(`${TEST_WEBAPP_URL}/`);

    // Open new tab
    const newTab = await client.newTab(`${TEST_WEBAPP_URL}/form.html`);

    assertNotCommandError(newTab, "B4 newTab");
    assertResult(newTab, "NewTabResult");
    expect(typeof newTab.tabId).toBe("string");

    // Switch to the new tab
    const switchResult = await client.switchTab(newTab.tabId);
    assertNotCommandError(switchResult, "B4 switchTab");
    assertResult(switchResult, "SwitchTabResult");

    // Close the new tab
    const closeResult = await client.closeTab(newTab.tabId);
    assertNotCommandError(closeResult, "B4 closeTab");
    assertResult(closeResult, "CloseTabResult");
  }, 60_000);

  /**
   * B5: JavaScript evaluate
   */
  test("B5: evaluate arithmetic returns correct value", async () => {
    await client.navigate(`${TEST_WEBAPP_URL}/`);

    const result = await client.evaluate("1 + 1");

    // MUST NOT be CommandError
    assertNotCommandError(result, "B5 evaluate");
    assertResult(result, "EvaluateResult");

    expect(result.value).toBe(2);
  }, 30_000);

  test("B5: evaluate document.title", async () => {
    await client.navigate(`${TEST_WEBAPP_URL}/`);

    const result = await client.evaluate("document.title");

    assertNotCommandError(result, "B5 evaluate title");
    assertResult(result, "EvaluateResult");

    expect(typeof result.value).toBe("string");
    expect((result.value as string).length).toBeGreaterThan(0);
  }, 30_000);

  test("B5: evaluate on dynamic.html page after content loads", async () => {
    await client.navigate(`${TEST_WEBAPP_URL}/dynamic.html`);

    // Wait for dynamic content to render (JS runs after 500ms)
    const waitResult = await client.wait(2_000);
    assertNotCommandError(waitResult, "B5 wait");

    const result = await client.evaluate(
      "document.querySelector('#dynamic-content')?.textContent ?? 'not found'"
    );

    assertNotCommandError(result, "B5 evaluate dynamic");
    assertResult(result, "EvaluateResult");

    // Dynamic content must be loaded (JavaScript rendered it)
    expect(result.value).not.toBe("not found");
    expect((result.value as string).length).toBeGreaterThan(0);
  }, 30_000);
});
