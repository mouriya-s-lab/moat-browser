import { describe, expect, it, mock, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Locator, Page, Response } from "patchright";
import type { BrowserCommand, CookieEntry } from "@moat-browser/types";
import { clearSessionRuntimeState, executeCommand, type Result } from "./cdp-bridge.js";
import type { RefStore } from "./ref-store.js";
import type { ControllerError, CommandResultData } from "@moat-browser/types";

// ─── Mock helpers ───

function mockLocator(overrides?: Partial<Locator>): Locator {
  const locator = {
    click: mock(() => Promise.resolve()),
    fill: mock((_v: string) => Promise.resolve()),
    pressSequentially: mock((_v: string) => Promise.resolve()),
    check: mock(() => Promise.resolve()),
    uncheck: mock(() => Promise.resolve()),
    hover: mock(() => Promise.resolve()),
    highlight: mock(() => Promise.resolve()),
    setInputFiles: mock(() => Promise.resolve()),
    dragTo: mock(() => Promise.resolve()),
    count: mock(() => Promise.resolve(1)),
    boundingBox: mock(() => Promise.resolve({ x: 1, y: 2, width: 3, height: 4 })),
    evaluateAll: mock(() => Promise.resolve([{
      tag: "button",
      text: "Submit",
      box: { x: 1, y: 2, width: 3, height: 4 },
      styles: {
        fontSize: "16px",
        fontWeight: "400",
        fontFamily: "sans-serif",
        color: "rgb(0, 0, 0)",
        backgroundColor: "rgb(255, 255, 255)",
        borderRadius: "0px",
      },
    }])),
    ariaSnapshot: mock(() => Promise.resolve('- heading "Test"\n- button "Click me"')),
    screenshot: mock(() => Promise.resolve(Buffer.from("locator-png-data"))),
    nth: mock(function (this: Locator) { return this; }),
    ...overrides,
  } as unknown as Locator;
  (locator as unknown as { getByRole: (role: string, options?: object) => Locator }).getByRole = mock(() => locator);
  return locator;
}

function mockPage(overrides?: Partial<Page>): Page {
  const loc = mockLocator();
  return {
    goto: mock((_url: string) => Promise.resolve(null as unknown as Response | null)),
    goBack: mock(() => Promise.resolve(null as unknown as Response | null)),
    goForward: mock(() => Promise.resolve(null as unknown as Response | null)),
    reload: mock(() => Promise.resolve(null as unknown as Response | null)),
    url: mock(() => "https://example.com"),
    title: mock(() => Promise.resolve("Example")),
    getByRole: mock(() => loc),
    getByLabel: mock(() => loc),
    getByPlaceholder: mock(() => loc),
    getByText: mock(() => loc),
    getByAltText: mock(() => loc),
    getByTitle: mock(() => loc),
    getByTestId: mock(() => loc),
    locator: mock(() => loc),
    screenshot: mock(() => Promise.resolve(Buffer.from("png-data"))),
    pdf: mock(() => Promise.resolve(Buffer.from("pdf-data"))),
    viewportSize: mock(() => ({ width: 800, height: 600 })),
    evaluate: mock((code: unknown) =>
      typeof code === "function"
        ? Promise.resolve({ status: "value", value: { answer: 42 } })
        : Promise.resolve({ answer: 42 })
    ),
    keyboard: {
      press: mock(() => Promise.resolve()),
      down: mock(() => Promise.resolve()),
      up: mock(() => Promise.resolve()),
      type: mock(() => Promise.resolve()),
      insertText: mock(() => Promise.resolve()),
    },
    mouse: {
      move: mock(() => Promise.resolve()),
      down: mock(() => Promise.resolve()),
      up: mock(() => Promise.resolve()),
      wheel: mock(() => Promise.resolve()),
    },
    setViewportSize: mock(() => Promise.resolve()),
    setExtraHTTPHeaders: mock(() => Promise.resolve()),
    emulateMedia: mock(() => Promise.resolve()),
    route: mock(() => Promise.resolve()),
    unroute: mock(() => Promise.resolve()),
    unrouteAll: mock(() => Promise.resolve()),
    on: mock(function (this: Page) { return this; }),
    ariaSnapshot: mock(() => Promise.resolve('- heading "Test"\n- button "Click me"')),
    close: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as Page;
}

function mockContext(pages: Page[], overrides?: Partial<BrowserContext>): BrowserContext {
  return {
    pages: () => pages,
    newPage: mock(async () => {
      const p = mockPage();
      pages.push(p);
      return p;
    }),
    cookies: mock((_urls?: string[]) =>
      Promise.resolve([
        {
          name: "sid",
          value: "abc",
          domain: ".example.com",
          path: "/",
          expires: 999999,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        },
      ]),
    ),
    grantPermissions: mock(() => Promise.resolve()),
    clearCookies: mock(() => Promise.resolve()),
    addCookies: mock(() => Promise.resolve()),
    setGeolocation: mock(() => Promise.resolve()),
    setOffline: mock(() => Promise.resolve()),
    setHTTPCredentials: mock(() => Promise.resolve()),
    storageState: mock(() => Promise.resolve({ cookies: [], origins: [] })),
    tracing: {
      start: mock(() => Promise.resolve()),
      stop: mock(async ({ path }: { path?: string } = {}) => {
        if (path) await Bun.write(path, "trace-data");
      }),
      startChunk: mock(() => Promise.resolve()),
      stopChunk: mock(() => Promise.resolve()),
      group: mock(() => Promise.resolve()),
      groupEnd: mock(() => Promise.resolve()),
    },
    newCDPSession: mock(() => Promise.resolve({
      send: mock(() => Promise.resolve()),
      on: mock(() => undefined),
      detach: mock(() => Promise.resolve()),
    })),
    ...overrides,
  } as unknown as BrowserContext;
}

function remoteDownloadContext(page: Page, bytes: Buffer): {
  readonly context: BrowserContext;
  readonly emitDownload: (filename: string) => void;
  readonly browserSend: ReturnType<typeof mock>;
  readonly pageSend: ReturnType<typeof mock>;
} {
  const listeners = new Map<string, (event: unknown) => void>();
  const browserSend = mock(() => Promise.resolve({}));
  const browserCdp = {
    send: browserSend,
    on: mock((event: string, listener: (value: unknown) => void) => {
      listeners.set(event, listener);
      return browserCdp;
    }),
    detach: mock(() => Promise.resolve()),
  };
  const pageSend = mock((method: string) => {
    if (method === "Page.getFrameTree") return Promise.resolve({ frameTree: { frame: { id: "frame-1" } } });
    return Promise.resolve({});
  });
  const pageCdp = { send: pageSend, detach: mock(() => Promise.resolve()) };
  const browser = { newBrowserCDPSession: mock(() => Promise.resolve(browserCdp)) };
  const context = mockContext([page], {
    browser: mock(() => browser) as BrowserContext["browser"],
    newCDPSession: mock(() => Promise.resolve(pageCdp)) as BrowserContext["newCDPSession"],
  });
  return {
    context,
    browserSend,
    pageSend,
    emitDownload(filename: string) {
      const directory = join(TEST_PROFILES_WORK, `agent-${SESSION}`, ".moat-downloads");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "download-guid"), bytes);
      listeners.get("Browser.downloadWillBegin")?.({
        frameId: "frame-1",
        guid: "download-guid",
        suggestedFilename: filename,
      });
      listeners.get("Browser.downloadProgress")?.({ guid: "download-guid", state: "completed" });
    },
  };
}

function mockRefStore(): RefStore {
  const store = new Map<string, Map<string, Locator>>();
  return {
    update(sessionId, refs) {
      store.set(sessionId, new Map(refs));
    },
    resolve(sessionId, ref) {
      return store.get(sessionId)?.get(ref);
    },
    resolveDetailed(sessionId, ref) {
      const locator = store.get(sessionId)?.get(ref);
      return locator ? { _tag: "Found", locator } : { _tag: "Missing" };
    },
    invalidate(sessionId, _reason) {
      store.set(sessionId, new Map());
    },
    clear(sessionId) {
      store.delete(sessionId);
    },
    entries(sessionId) {
      return Array.from(store.get(sessionId)?.entries() ?? []);
    },
  };
}

function assertOk(r: Result<CommandResultData, ControllerError>): CommandResultData {
  expect(r._tag).toBe("Ok");
  if (r._tag !== "Ok") throw new Error("Expected Ok");
  return r.value;
}

function assertErr(r: Result<CommandResultData, ControllerError>): ControllerError {
  expect(r._tag).toBe("Err");
  if (r._tag !== "Err") throw new Error("Expected Err");
  return r.error;
}

// ─── Tests ───

const SESSION = "test-session";
const TEST_PROFILES_WORK = mkdtempSync(join(tmpdir(), "moat-controller-profiles-"));

describe("cdp-bridge", () => {
  let page: Page;
  let ctx: BrowserContext;
  let refStore: RefStore;

  beforeEach(() => {
    process.env.PROFILES_WORK = TEST_PROFILES_WORK;
    clearSessionRuntimeState(SESSION);
    page = mockPage();
    ctx = mockContext([page]);
    refStore = mockRefStore();
  });

  // ─── Navigation actions → NavigateResult ───

  describe("navigate → NavigateResult", () => {
    it("navigate returns NavigateResult", async () => {
      const r = await executeCommand(ctx, { action: "navigate", url: "https://example.com" }, refStore, SESSION);
      const data = assertOk(r);
      expect(data._tag).toBe("NavigateResult");
      if (data._tag === "NavigateResult") {
        expect(data.url).toBe("https://example.com");
        expect(data.title).toBe("Example");
      }
    });

    it("navigate applies request headers and wait strategy", async () => {
      await executeCommand(ctx, {
        action: "navigate",
        url: "https://example.com",
        waitUntil: "networkidle",
        headers: { "X-Test": "yes" },
      }, refStore, SESSION);
      expect(page.setExtraHTTPHeaders).toHaveBeenCalledWith({ "X-Test": "yes" });
      expect(page.goto).toHaveBeenCalledWith("https://example.com", { waitUntil: "networkidle" });
    });

    it("back returns NavigateResult", async () => {
      const r = await executeCommand(ctx, { action: "back" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("NavigateResult");
    });

    it("forward returns NavigateResult", async () => {
      const r = await executeCommand(ctx, { action: "forward" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("NavigateResult");
    });

    it("reload returns NavigateResult", async () => {
      const r = await executeCommand(ctx, { action: "reload" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("NavigateResult");
    });
  });

  // ─── Semantic locator actions ───

  describe("semantic locators", () => {
    it("getbyrole without subaction returns LocatorResult", async () => {
      const r = await executeCommand(ctx, { action: "getbyrole", role: "button" }, refStore, SESSION);
      const data = assertOk(r);
      expect(data._tag).toBe("LocatorResult");
      if (data._tag === "LocatorResult") {
        expect(data.found).toBe(true);
        expect(data.count).toBe(1);
      }
    });

    it("getbyrole with click subaction returns VoidResult", async () => {
      const r = await executeCommand(ctx, { action: "getbyrole", role: "button", subaction: "click" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
    });

    it("getbyrole with fill subaction returns VoidResult", async () => {
      const r = await executeCommand(ctx, { action: "getbyrole", role: "textbox", subaction: "fill", value: "hello" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
    });

    it("getbyrole with type subaction uses pressSequentially", async () => {
      const r = await executeCommand(ctx, { action: "getbyrole", role: "textbox", subaction: "type", value: "hi" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
    });

    it("getbyrole with check subaction returns VoidResult", async () => {
      const r = await executeCommand(ctx, { action: "getbyrole", role: "checkbox", subaction: "check" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
    });

    it("getbyrole with uncheck subaction returns VoidResult", async () => {
      const r = await executeCommand(ctx, { action: "getbyrole", role: "checkbox", subaction: "uncheck" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
    });

    it("getbyrole with hover subaction returns VoidResult", async () => {
      const r = await executeCommand(ctx, { action: "getbyrole", role: "button", subaction: "hover" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
    });

    it("getbyrole with nth narrows to nth element", async () => {
      await executeCommand(ctx, { action: "getbyrole", role: "button", nth: 2 }, refStore, SESSION);
      const loc = (page.getByRole as ReturnType<typeof mock>).mock.results[0].value;
      expect(loc.nth).toHaveBeenCalledWith(2);
    });

    it("getbylabel without subaction returns LocatorResult", async () => {
      const r = await executeCommand(ctx, { action: "getbylabel", label: "Email" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("LocatorResult");
    });

    it("getbyplaceholder without subaction returns LocatorResult", async () => {
      const r = await executeCommand(ctx, { action: "getbyplaceholder", placeholder: "Search..." }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("LocatorResult");
    });

    it("getbytext without subaction returns LocatorResult", async () => {
      const r = await executeCommand(ctx, { action: "getbytext", text: "Hello" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("LocatorResult");
    });

    it("getbyalttext without subaction returns LocatorResult", async () => {
      const r = await executeCommand(ctx, { action: "getbyalttext", text: "Logo" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("LocatorResult");
    });

    it("getbytitle without subaction returns LocatorResult", async () => {
      const r = await executeCommand(ctx, { action: "getbytitle", text: "Home" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("LocatorResult");
    });

    it("getbytestid without subaction returns LocatorResult", async () => {
      const r = await executeCommand(ctx, { action: "getbytestid", testId: "submit-btn" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("LocatorResult");
    });
  });

  // ─── @eN reference actions → VoidResult ───

  describe("ref actions", () => {
    beforeEach(() => {
      const loc = mockLocator();
      const refs = new Map<string, Locator>([["@e1", loc]]);
      refStore.update(SESSION, refs);
    });

    it("click ref returns VoidResult", async () => {
      const r = await executeCommand(ctx, { action: "click", ref: "@e1" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
    });

    it("fill ref returns VoidResult", async () => {
      const r = await executeCommand(ctx, { action: "fill", ref: "@e1", value: "text" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
    });

    it("type ref returns VoidResult (uses pressSequentially)", async () => {
      const r = await executeCommand(ctx, { action: "type", ref: "@e1", value: "text" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
    });

    it("hover ref returns VoidResult", async () => {
      const r = await executeCommand(ctx, { action: "hover", ref: "@e1" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
    });

    it("missing ref returns ElementNotFound", async () => {
      const r = await executeCommand(ctx, { action: "click", ref: "@e999" }, refStore, SESSION);
      const e = assertErr(r);
      expect(e._tag).toBe("ElementNotFound");
    });
  });

  // ─── Page info actions ───

  describe("page info", () => {
    it("snapshot returns SnapshotResult", async () => {
      const r = await executeCommand(ctx, { action: "snapshot" }, refStore, SESSION);
      const data = assertOk(r);
      expect(data._tag).toBe("SnapshotResult");
      if (data._tag === "SnapshotResult") {
        expect(typeof data.snapshot).toBe("string");
      }
    });

    it("snapshot applies selector interactive and depth options", async () => {
      const locator = mockLocator({
        ariaSnapshot: mock(() => Promise.resolve('- heading "Title"\n  - button "Deep"\n- link "Top"')),
      });
      page = mockPage({ locator: mock(() => locator) });
      ctx = mockContext([page]);
      const r = await executeCommand(ctx, {
        action: "snapshot",
        selector: "main",
        interactive: true,
        compact: true,
        maxDepth: 0,
      }, refStore, SESSION);
      const data = assertOk(r);
      expect(page.locator).toHaveBeenCalledWith("main");
      if (data._tag === "SnapshotResult") {
        expect(data.snapshot).toBe('- @e1 link "Top"');
      }
    });

    it("screenshot returns ScreenshotResult", async () => {
      const r = await executeCommand(ctx, { action: "screenshot" }, refStore, SESSION);
      const data = assertOk(r);
      expect(data._tag).toBe("ScreenshotResult");
      if (data._tag === "ScreenshotResult") {
        expect(data.format).toBe("png");
        expect(typeof data.base64).toBe("string");
      }
    });

    it("screenshot jpeg uses format and quality", async () => {
      const r = await executeCommand(ctx, { action: "screenshot", format: "jpeg", quality: 50 }, refStore, SESSION);
      const data = assertOk(r);
      expect(data._tag).toBe("ScreenshotResult");
      if (data._tag === "ScreenshotResult") {
        expect(data.format).toBe("jpeg");
      }
    });

    it("screenshot applies selector or full page capture options", async () => {
      const locator = mockLocator();
      page = mockPage({ locator: mock(() => locator) });
      ctx = mockContext([page]);
      await executeCommand(ctx, { action: "screenshot", selector: "main" }, refStore, SESSION);
      expect(locator.screenshot).toHaveBeenCalled();
      await executeCommand(ctx, { action: "screenshot", fullPage: true }, refStore, SESSION);
      expect(page.screenshot).toHaveBeenLastCalledWith(expect.objectContaining({ fullPage: true }));
    });

    it("annotated screenshot draws and removes overlays around interactive refs", async () => {
      const r = await executeCommand(ctx, { action: "screenshot", annotate: true }, refStore, SESSION);
      const data = assertOk(r);
      expect(page.evaluate).toHaveBeenCalledTimes(2);
      if (data._tag === "ScreenshotResult") {
        expect(data.annotations?.map((annotation) => annotation.ref)).toEqual(["@e1"]);
      }
    });

    it("eval returns EvalResult with the original value type", async () => {
      const r = await executeCommand(ctx, { action: "eval", code: "1+1" }, refStore, SESSION);
      const data = assertOk(r);
      expect(data._tag).toBe("EvalResult");
      if (data._tag === "EvalResult") {
        expect(data.result).toEqual({ answer: 42 });
      }
    });

    it("url returns the active page URL", async () => {
      const data = assertOk(await executeCommand(ctx, { action: "url" }, refStore, SESSION));
      expect(data).toEqual({ _tag: "PageUrlResult", url: "https://example.com" });
    });

    it("title returns the active page title", async () => {
      const data = assertOk(await executeCommand(ctx, { action: "title" }, refStore, SESSION));
      expect(data).toEqual({ _tag: "PageTitleResult", title: "Example" });
    });

    it("count returns matching element count", async () => {
      const data = assertOk(await executeCommand(ctx, { action: "count", selector: ".item" }, refStore, SESSION));
      expect(data).toEqual({ _tag: "CountResult", count: 1 });
    });

    it("boundingbox returns locator geometry", async () => {
      const data = assertOk(await executeCommand(ctx, { action: "boundingbox", selector: "button" }, refStore, SESSION));
      expect(data).toEqual({
        _tag: "BoundingBoxResult",
        box: { _tag: "Box", x: 1, y: 2, width: 3, height: 4 },
      });
    });

    it("styles returns computed style details", async () => {
      const data = assertOk(await executeCommand(ctx, { action: "styles", selector: "button" }, refStore, SESSION));
      expect(data._tag).toBe("ElementStylesResult");
      if (data._tag === "ElementStylesResult") {
        expect(data.elements[0].tag).toBe("button");
        expect(data.elements[0].styles.fontSize).toBe("16px");
      }
    });
  });

  // ─── Keyboard / scroll / wait ───

  describe("keyboard, scroll, wait", () => {
    it("press returns VoidResult", async () => {
      const r = await executeCommand(ctx, { action: "press", key: "Enter" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
    });

    it("scroll returns measured ScrollResult", async () => {
      const r = await executeCommand(ctx, { action: "scroll", direction: "down" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("ScrollResult");
    });

    it("wait returns VoidResult", async () => {
      const r = await executeCommand(ctx, { action: "wait", time: 1 }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("WaitResult");
    });
  });

  describe("mouse, drag, and browser settings", () => {
    it("drag moves the source locator to the target locator", async () => {
      const source = mockLocator();
      const target = mockLocator();
      page = mockPage({
        locator: mock((selector: string) => selector === "#source" ? source : target),
      });
      ctx = mockContext([page]);
      const data = assertOk(await executeCommand(ctx, {
        action: "drag",
        source: "#source",
        target: "#target",
      }, refStore, SESSION));
      expect(data._tag).toBe("VoidResult");
      expect(source.dragTo).toHaveBeenCalledWith(target);
    });

    it("mouse commands call the corresponding page mouse APIs", async () => {
      await executeCommand(ctx, { action: "mousemove", x: 10, y: 20 }, refStore, SESSION);
      await executeCommand(ctx, { action: "mousedown", button: "left" }, refStore, SESSION);
      await executeCommand(ctx, { action: "mouseup", button: "right" }, refStore, SESSION);
      await executeCommand(ctx, { action: "wheel", deltaX: 3, deltaY: 4 }, refStore, SESSION);
      expect(page.mouse.move).toHaveBeenCalledWith(10, 20);
      expect(page.mouse.down).toHaveBeenCalledWith({ button: "left" });
      expect(page.mouse.up).toHaveBeenCalledWith({ button: "right" });
      expect(page.mouse.wheel).toHaveBeenCalledWith(3, 4);
    });

    it("viewport applies dimensions and device scale factor through CDP", async () => {
      const send = mock(() => Promise.resolve());
      const detach = mock(() => Promise.resolve());
      ctx = mockContext([page], {
        newCDPSession: mock(() => Promise.resolve({ send, detach })) as BrowserContext["newCDPSession"],
      });
      const data = assertOk(await executeCommand(ctx, {
        action: "viewport",
        width: 800,
        height: 600,
        deviceScaleFactor: 2,
      }, refStore, SESSION));
      expect(data._tag).toBe("VoidResult");
      expect(send).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", {
        width: 800,
        height: 600,
        deviceScaleFactor: 2,
        mobile: false,
      });
      expect(page.setViewportSize).not.toHaveBeenCalled();
      expect(detach).toHaveBeenCalledTimes(0);
    });

    it("device applies metrics, touch, user agent metadata, and viewport", async () => {
      const send = mock(() => Promise.resolve());
      const detach = mock(() => Promise.resolve());
      ctx = mockContext([page], {
        newCDPSession: mock(() => Promise.resolve({ send, detach })) as BrowserContext["newCDPSession"],
      });

      const data = assertOk(await executeCommand(ctx, {
        action: "device",
        device: "iPhone 13",
      }, refStore, SESSION));

      expect(data._tag).toBe("VoidResult");
      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[0][0]).toBe("Emulation.setDeviceMetricsOverride");
      expect(send.mock.calls[0][1]).toMatchObject({
        width: 390,
        height: 664,
        deviceScaleFactor: 3,
        mobile: true,
      });
      expect(send.mock.calls[1]).toEqual(["Emulation.setTouchEmulationEnabled", { enabled: true }]);
      expect(send.mock.calls[2][0]).toBe("Network.setUserAgentOverride");
      expect(send.mock.calls[2][1]).toMatchObject({
        userAgent: expect.any(String),
        userAgentMetadata: { mobile: true },
      });
      expect(page.setViewportSize).not.toHaveBeenCalled();
      expect(detach).toHaveBeenCalledTimes(0);
    });

    it("device rejects an unknown descriptor without changing the page", async () => {
      const error = assertErr(await executeCommand(ctx, {
        action: "device",
        device: "Definitely Not A Device",
      }, refStore, SESSION));

      expect(error).toEqual({
        _tag: "ValidationFailed",
        message: "Unknown device: Definitely Not A Device; run `moat device list` to list available remote Chromium descriptors",
      });
      expect(ctx.newCDPSession).not.toHaveBeenCalled();
      expect(page.setViewportSize).not.toHaveBeenCalled();
    });

    it("geolocation, offline, headers, credentials, and media update the browser", async () => {
      await executeCommand(ctx, { action: "geolocation", latitude: 35, longitude: 139 }, refStore, SESSION);
      await executeCommand(ctx, { action: "offline", offline: true }, refStore, SESSION);
      await executeCommand(ctx, { action: "headers", headers: { "X-Audit": "1" } }, refStore, SESSION);
      await executeCommand(ctx, { action: "credentials", username: "u", password: "p" }, refStore, SESSION);
      await executeCommand(ctx, {
        action: "emulatemedia",
        colorScheme: "dark",
        reducedMotion: "reduce",
      }, refStore, SESSION);
      expect(ctx.grantPermissions).toHaveBeenCalledWith(["geolocation"]);
      expect(ctx.setGeolocation).toHaveBeenCalledWith({ latitude: 35, longitude: 139 });
      expect(ctx.setOffline).toHaveBeenCalledWith(true);
      expect(page.setExtraHTTPHeaders).toHaveBeenCalledWith({ "X-Audit": "1" });
      expect(ctx.setHTTPCredentials).toHaveBeenCalledWith({ username: "u", password: "p" });
      expect(page.emulateMedia).toHaveBeenCalledWith({ colorScheme: "dark", reducedMotion: "reduce" });
    });
  });

  describe("storage", () => {
    it("storage_get returns one key", async () => {
      page = mockPage({ evaluate: mock(() => Promise.resolve("saved")) });
      ctx = mockContext([page]);
      const data = assertOk(await executeCommand(ctx, {
        action: "storage_get",
        type: "local",
        key: "audit",
      }, refStore, SESSION));
      expect(data).toEqual({ _tag: "StorageResult", key: "audit", value: "saved" });
    });

    it("storage_get returns all entries", async () => {
      page = mockPage({ evaluate: mock(() => Promise.resolve({ audit: "saved" })) });
      ctx = mockContext([page]);
      const data = assertOk(await executeCommand(ctx, {
        action: "storage_get",
        type: "session",
      }, refStore, SESSION));
      expect(data).toEqual({ _tag: "StorageResult", data: { audit: "saved" } });
    });

    it("storage_set and storage_clear execute in the selected storage", async () => {
      await executeCommand(ctx, {
        action: "storage_set",
        type: "local",
        key: "audit",
        value: "saved",
      }, refStore, SESSION);
      await executeCommand(ctx, { action: "storage_clear", type: "session" }, refStore, SESSION);
      expect(page.evaluate).toHaveBeenCalledTimes(2);
    });
  });

  describe("network and runtime logs", () => {
    it("route and unroute install and remove matching handlers", async () => {
      await executeCommand(ctx, {
        action: "route",
        url: "**/api/*",
        abort: true,
      }, refStore, SESSION);
      await executeCommand(ctx, { action: "unroute", url: "**/api/*" }, refStore, SESSION);
      await executeCommand(ctx, { action: "unroute" }, refStore, SESSION);
      expect(page.route).toHaveBeenCalledTimes(1);
      expect(page.unroute).toHaveBeenCalledWith("**/api/*");
      expect(page.unrouteAll).toHaveBeenCalledWith({ behavior: "wait" });
    });

    it("console and page error commands return observed events and clear them", async () => {
      const handlers = new Map<string, (value: unknown) => void>();
      const pageHandlers = new Map<string, (value: unknown) => void>();
      const detach = mock(() => Promise.resolve());
      page = mockPage({
        on: mock((event: string, handler: (value: unknown) => void) => {
          pageHandlers.set(event, handler);
          return page;
        }) as Page["on"],
      });
      ctx = mockContext([page], {
        newCDPSession: mock(() => Promise.resolve({
          send: mock(() => Promise.resolve()),
          on: mock((event: string, handler: (value: unknown) => void) => {
            handlers.set(event, handler);
          }),
          detach,
        })) as BrowserContext["newCDPSession"],
      });
      await executeCommand(ctx, { action: "eval", code: "true" }, refStore, SESSION);
      handlers.get("Runtime.consoleAPICalled")?.({
        type: "log",
        args: [{ type: "string", value: "hello" }, { type: "number", value: 42 }],
      });
      handlers.get("Runtime.exceptionThrown")?.({
        exceptionDetails: { text: "Uncaught", exception: { description: "Error: broken" } },
      });
      // Patchright may emit the corresponding high-level events too. Once the
      // CDP observer is active they must not duplicate the same browser event.
      pageHandlers.get("console")?.({ type: () => "log", text: () => "hello 42" });
      pageHandlers.get("pageerror")?.(new Error("Error: broken"));

      const consoleData = assertOk(await executeCommand(ctx, { action: "console" }, refStore, SESSION));
      const errorData = assertOk(await executeCommand(ctx, { action: "errors" }, refStore, SESSION));
      expect(consoleData._tag).toBe("ConsoleResult");
      expect(errorData._tag).toBe("PageErrorsResult");
      if (consoleData._tag === "ConsoleResult") {
        expect(consoleData.messages).toHaveLength(1);
        expect(consoleData.messages[0]).toMatchObject({
          _tag: "ConsoleDiagnostic",
          type: "log",
          text: "hello 42",
          sessionId: SESSION,
          pageId: "page-1",
          frameId: "frame-main",
          pageUrl: "https://example.com",
          frameUrl: "https://example.com",
        });
      }
      if (errorData._tag === "PageErrorsResult") {
        expect(errorData.errors).toHaveLength(1);
        expect(errorData.errors[0]).toMatchObject({
          _tag: "PageErrorDiagnostic",
          message: "Error: broken",
          sessionId: SESSION,
          pageId: "page-1",
          frameId: "frame-main",
          pageUrl: "https://example.com",
          frameUrl: "https://example.com",
        });
      }

      expect(assertOk(await executeCommand(ctx, { action: "console", clear: true }, refStore, SESSION)))
        .toEqual({ _tag: "ClearedResult", cleared: true });
      expect(assertOk(await executeCommand(ctx, { action: "errors", clear: true }, refStore, SESSION)))
        .toEqual({ _tag: "ClearedResult", cleared: true });
      expect(assertOk(await executeCommand(ctx, { action: "console" }, refStore, SESSION)))
        .toEqual({ _tag: "ConsoleResult", messages: [] });
      expect(assertOk(await executeCommand(ctx, { action: "errors" }, refStore, SESSION)))
        .toEqual({ _tag: "PageErrorsResult", errors: [] });
      clearSessionRuntimeState(SESSION);
      expect(detach).toHaveBeenCalledTimes(1);
    });

    it("network requests returns observed request metadata", async () => {
      const handlers = new Map<string, (value: unknown) => void>();
      page = mockPage({
        on: mock((event: string, handler: (value: unknown) => void) => {
          handlers.set(event, handler);
          return page;
        }) as Page["on"],
      });
      ctx = mockContext([page]);
      await executeCommand(ctx, { action: "reload" }, refStore, SESSION);
      const request = {
        url: () => "https://example.com/api/items",
        method: () => "GET",
        resourceType: () => "fetch",
        headers: () => ({ accept: "application/json" }),
        postData: () => null,
      };
      handlers.get("request")?.(request);
      const data = assertOk(await executeCommand(ctx, {
        action: "requests",
        clear: false,
        filter: "/api/",
        type: "fetch",
        method: "GET",
      }, refStore, SESSION));
      expect(data._tag).toBe("NetworkRequestsResult");
      if (data._tag === "NetworkRequestsResult") {
        expect(data.requests).toHaveLength(1);
        expect(data.requests[0].url).toBe("https://example.com/api/items");
      }
    });

    it("highlight invokes the locator highlight effect", async () => {
      const locator = page.locator("#button");
      const data = assertOk(await executeCommand(ctx, {
        action: "highlight",
        selector: "#button",
      }, refStore, SESSION));
      expect(data._tag).toBe("VoidResult");
      expect(locator.highlight).toHaveBeenCalledTimes(1);
    });
  });

  describe("file transfer", () => {
    it("upload decodes file content and preserves name and MIME type", async () => {
      const setInputFiles = mock(() => Promise.resolve());
      page = mockPage({ locator: mock(() => mockLocator({ setInputFiles })) });
      ctx = mockContext([page]);

      const data = assertOk(await executeCommand(ctx, {
        action: "upload",
        selector: "input[type=file]",
        files: [{
          name: "audit.txt",
          mimeType: "text/plain",
          base64: Buffer.from("uploaded bytes").toString("base64"),
        }],
      }, refStore, SESSION));

      expect(data._tag).toBe("VoidResult");
      expect(setInputFiles).toHaveBeenCalledTimes(1);
      const [files] = setInputFiles.mock.calls[0];
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe("audit.txt");
      expect(files[0].mimeType).toBe("text/plain");
      expect(Buffer.from(files[0].buffer).toString()).toBe("uploaded bytes");
    });

    it("download clicks the target and returns streamed bytes", async () => {
      let emitDownload = (_filename: string): void => {};
      const click = mock(() => {
        emitDownload("report.txt");
        return Promise.resolve();
      });
      const locator = mockLocator({ click });
      page = mockPage({ locator: mock(() => locator) });
      const remote = remoteDownloadContext(page, Buffer.from("downloaded bytes"));
      emitDownload = remote.emitDownload;
      ctx = remote.context;

      const data = assertOk(await executeCommand(ctx, {
        action: "download",
        selector: "#download",
      }, refStore, SESSION));

      expect(click).toHaveBeenCalledTimes(1);
      expect(data).toEqual({
        _tag: "BinaryFileResult",
        base64: Buffer.from("downloaded bytes").toString("base64"),
        suggestedFilename: "report.txt",
      });
      expect(remote.browserSend).toHaveBeenCalledWith("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: "/data/profile/.moat-downloads",
        eventsEnabled: true,
      });
    });

    it("wait for download returns bytes from the remote Chrome filesystem", async () => {
      page = mockPage();
      const remote = remoteDownloadContext(page, Buffer.from("event bytes"));
      ctx = remote.context;
      setTimeout(() => remote.emitDownload("event.bin"), 0);

      const data = assertOk(await executeCommand(ctx, {
        action: "waitfordownload",
        timeout: 1234,
      }, refStore, SESSION));

      expect(data).toEqual({
        _tag: "BinaryFileResult",
        base64: Buffer.from("event bytes").toString("base64"),
        suggestedFilename: "event.bin",
      });
    });

    it("pdf returns the generated document bytes", async () => {
      const data = assertOk(await executeCommand(ctx, { action: "pdf" }, refStore, SESSION));
      expect(page.pdf).toHaveBeenCalledTimes(1);
      expect(data).toEqual({
        _tag: "BinaryFileResult",
        base64: Buffer.from("pdf-data").toString("base64"),
        suggestedFilename: "page.pdf",
      });
    });
  });

  describe("clipboard, touch, dialog, and frame state", () => {
    it("clipboard reads, writes, copies, and pastes through the active page", async () => {
      page = mockPage({ evaluate: mock(() => Promise.resolve("clipboard text")) });
      ctx = mockContext([page]);

      expect(assertOk(await executeCommand(ctx, {
        action: "clipboard",
        operation: "read",
      }, refStore, SESSION))).toEqual({ _tag: "ClipboardResult", text: "clipboard text" });
      expect(assertOk(await executeCommand(ctx, {
        action: "clipboard",
        operation: "write",
        text: "new text",
      }, refStore, SESSION))).toEqual({ _tag: "ClipboardResult", written: "new text" });
      expect(assertOk(await executeCommand(ctx, {
        action: "clipboard",
        operation: "copy",
      }, refStore, SESSION))).toEqual({ _tag: "ClipboardResult", copied: true });
      expect(assertOk(await executeCommand(ctx, {
        action: "clipboard",
        operation: "paste",
      }, refStore, SESSION))).toEqual({ _tag: "ClipboardResult", pasted: true });
      expect(ctx.grantPermissions).toHaveBeenCalledTimes(4);
      expect(ctx.grantPermissions).toHaveBeenCalledWith(["clipboard-read", "clipboard-write"]);
      expect(page.keyboard.press).toHaveBeenCalledWith("Control+C");
      expect(page.keyboard.press).toHaveBeenCalledWith("Control+V");
    });

    it("tap and swipe dispatch touch events through CDP", async () => {
      const send = mock(() => Promise.resolve());
      const detach = mock(() => Promise.resolve());
      ctx = mockContext([page], {
        newCDPSession: mock(() => Promise.resolve({ send, detach })) as BrowserContext["newCDPSession"],
      });

      expect(assertOk(await executeCommand(ctx, {
        action: "tap",
        selector: "#touch",
      }, refStore, SESSION))).toEqual({ _tag: "TouchResult", tapped: "#touch" });
      expect(assertOk(await executeCommand(ctx, {
        action: "swipe",
        direction: "up",
        distance: 200,
      }, refStore, SESSION))).toEqual({ _tag: "TouchResult", swiped: "up" });
      expect(send.mock.calls[0]).toEqual([
        "Input.dispatchTouchEvent",
        { type: "touchStart", touchPoints: [{ x: 2.5, y: 4 }] },
      ]);
      expect(send).toHaveBeenCalledTimes(14);
      expect(detach).toHaveBeenCalledTimes(2);
    });

    it("dialog status exposes the pending dialog and accept resolves it", async () => {
      const handlers = new Map<string, (value: unknown) => void>();
      page = mockPage({
        on: mock((event: string, handler: (value: unknown) => void) => {
          handlers.set(event, handler);
          return page;
        }) as Page["on"],
      });
      ctx = mockContext([page]);
      const accept = mock(() => Promise.resolve());
      handlers.set("placeholder", () => {});
      await executeCommand(ctx, { action: "dialog", response: "status" }, refStore, SESSION);
      handlers.get("dialog")?.({
        type: () => "prompt",
        message: () => "Your name?",
        defaultValue: () => "Guest",
        accept,
        dismiss: mock(() => Promise.resolve()),
      });

      expect(assertOk(await executeCommand(ctx, {
        action: "dialog",
        response: "status",
      }, refStore, SESSION))).toEqual({
        _tag: "DialogResult",
        hasDialog: true,
        type: "prompt",
        message: "Your name?",
        defaultPrompt: "Guest",
      });
      expect(assertOk(await executeCommand(ctx, {
        action: "dialog",
        response: "accept",
        promptText: "Moat",
      }, refStore, SESSION))).toEqual({
        _tag: "DialogResult",
        handled: true,
        accepted: true,
      });
      expect(accept).toHaveBeenCalledWith("Moat");
      expect(assertOk(await executeCommand(ctx, {
        action: "dialog",
        response: "status",
      }, refStore, SESSION))).toEqual({ _tag: "DialogResult", hasDialog: false });
    });

    it("waits for a scheduled dialog before accepting it", async () => {
      const accept = mock(() => Promise.resolve());
      const dialog = {
        type: () => "prompt",
        message: () => "Later",
        defaultValue: () => "",
        accept,
        dismiss: mock(() => Promise.resolve()),
      };
      const waitForEvent = mock(() => Promise.resolve(dialog));
      page = mockPage({ waitForEvent: waitForEvent as Page["waitForEvent"] });
      ctx = mockContext([page]);

      expect(assertOk(await executeCommand(ctx, {
        action: "dialog",
        response: "accept",
        promptText: "ready",
      }, refStore, SESSION))).toEqual({
        _tag: "DialogResult",
        handled: true,
        accepted: true,
      });
      expect(waitForEvent).toHaveBeenCalledWith("dialog", { timeout: 5_000 });
      expect(accept).toHaveBeenCalledWith("ready");
    });

    it("frame scopes later locator commands until returning to main", async () => {
      const inside = mockLocator({ textContent: mock(() => Promise.resolve("inside")) });
      const frame = mockPage({ locator: mock(() => inside) });
      const iframe = mockLocator({
        elementHandle: mock(() => Promise.resolve({
          contentFrame: mock(() => Promise.resolve(frame)),
        })),
      });
      const outside = mockLocator({ textContent: mock(() => Promise.resolve("outside")) });
      page = mockPage({
        locator: mock((selector: string) => selector === "iframe" ? iframe : outside),
      });
      ctx = mockContext([page]);

      expect(assertOk(await executeCommand(ctx, {
        action: "frame",
        selector: "iframe",
      }, refStore, SESSION))).toEqual({ _tag: "FrameResult", frame: "iframe" });
      expect(assertOk(await executeCommand(ctx, {
        action: "gettext",
        selector: "#content",
      }, refStore, SESSION))).toEqual({ _tag: "GetTextResult", text: "inside" });
      expect(assertOk(await executeCommand(ctx, {
        action: "mainframe",
      }, refStore, SESSION))).toEqual({ _tag: "FrameResult", frame: "main" });
      expect(assertOk(await executeCommand(ctx, {
        action: "gettext",
        selector: "#content",
      }, refStore, SESSION))).toEqual({ _tag: "GetTextResult", text: "outside" });
    });

    it("returns stable moat errors and remote device descriptors", async () => {
      const inspect = assertErr(await executeCommand(ctx, { action: "inspect" }, refStore, SESSION));
      const devices = assertOk(await executeCommand(ctx, { action: "device_list" }, refStore, SESSION));
      expect(inspect._tag).toBe("CommandFailed");
      if (inspect._tag === "CommandFailed") expect(inspect.message).toStartWith("unsupported_in_moat:");
      expect(devices._tag).toBe("DeviceListResult");
      if (devices._tag === "DeviceListResult") {
        expect(devices.devices.length).toBeGreaterThan(0);
        expect(devices.devices[0]).toMatchObject({
          name: expect.any(String),
          userAgent: expect.any(String),
          viewport: { width: expect.any(Number), height: expect.any(Number) },
          screen: { width: expect.any(Number), height: expect.any(Number) },
          userAgentMetadata: expect.objectContaining({ mobile: expect.any(Boolean) }),
        });
      }
    });
  });

  describe("browser state transfer", () => {
    it("state_save serializes cookies plus local and per-tab session storage", async () => {
      page = mockPage({
        url: mock(() => "https://example.com/page"),
        evaluate: mock(() => Promise.resolve([{ name: "session-key", value: "session-value" }])),
      });
      ctx = mockContext([page], {
        storageState: mock(() => Promise.resolve({
          cookies: [{
            name: "sid",
            value: "cookie-value",
            domain: "example.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          }],
          origins: [{
            origin: "https://example.com",
            localStorage: [{ name: "local-key", value: "local-value" }],
            indexedDB: [],
          }],
        })),
      });

      const data = assertOk(await executeCommand(ctx, { action: "state_save" }, refStore, SESSION));

      expect(data._tag).toBe("BinaryFileResult");
      if (data._tag === "BinaryFileResult") {
        const state = JSON.parse(Buffer.from(data.base64, "base64").toString());
        expect(state.schemaVersion).toBe(2);
        expect(state.cookies[0].name).toBe("sid");
        expect(state.origins[0].localStorage[0]).toEqual({ name: "local-key", value: "local-value" });
        expect(state.tabs[0].sessionStorage[0]).toEqual({ name: "session-key", value: "session-value" });
      }
    });

    it("state_load preserves unrelated cookies and restores storage per matched tab", async () => {
      ctx = mockContext([page]);
      const state = {
        schemaVersion: 2 as const,
        cookies: [{
          name: "sid",
          value: "cookie-value",
          domain: "example.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        }],
        origins: [{
          origin: "https://example.com",
          localStorage: [{ name: "local-key", value: "local-value" }],
          indexedDB: [],
        }],
        tabs: [{
          url: "https://example.com",
          sessionStorage: [{ name: "session-key", value: "session-value" }],
        }],
      };

      const data = assertOk(await executeCommand(ctx, { action: "state_load", state }, refStore, SESSION));

      expect(data).toEqual({
        _tag: "StateLoadResult",
        status: "complete",
        loaded: true,
        cookies: 1,
        origins: 1,
        tabs: 1,
        indexedDB: 0,
      });
      expect(ctx.clearCookies).not.toHaveBeenCalled();
      expect(ctx.addCookies).toHaveBeenCalledWith(state.cookies);
    });
  });

  describe("trace, profiler, and HAR artifacts", () => {
    it("trace start and stop return a transferable trace archive", async () => {
      expect(assertOk(await executeCommand(ctx, { action: "trace_start" }, refStore, SESSION)))
        .toEqual({ _tag: "StartedResult", started: true });

      const data = assertOk(await executeCommand(ctx, { action: "trace_stop" }, refStore, SESSION));

      expect(ctx.tracing.start).toHaveBeenCalledWith({ screenshots: true, snapshots: true, sources: true });
      expect(data).toEqual({
        _tag: "BinaryFileResult",
        base64: Buffer.from("trace-data").toString("base64"),
        suggestedFilename: "trace.zip",
      });
    });

    it("profiler returns the CDP trace stream and event count", async () => {
      let complete: ((event: { stream?: string }) => void) | undefined;
      const send = mock((method: string) => {
        if (method === "Tracing.end") queueMicrotask(() => complete?.({ stream: "profile-stream" }));
        if (method === "IO.read") {
          return Promise.resolve({
            data: JSON.stringify({ traceEvents: [{ name: "one" }, { name: "two" }] }),
            eof: true,
          });
        }
        return Promise.resolve({});
      });
      const detach = mock(() => Promise.resolve());
      const cdp = {
        send,
        detach,
        once: mock((_event: string, handler: (event: { stream?: string }) => void) => {
          complete = handler;
          return cdp;
        }),
      };
      ctx = mockContext([page], {
        newCDPSession: mock(() => Promise.resolve(cdp)) as BrowserContext["newCDPSession"],
      });

      expect(assertOk(await executeCommand(ctx, {
        action: "profiler_start",
        categories: ["devtools.timeline"],
      }, refStore, SESSION))).toEqual({ _tag: "StartedResult", started: true });
      const data = assertOk(await executeCommand(ctx, { action: "profiler_stop" }, refStore, SESSION));

      expect(send).toHaveBeenCalledWith("Tracing.start", {
        traceConfig: { includedCategories: ["devtools.timeline"], enableSampling: true },
        transferMode: "ReturnAsStream",
      });
      expect(data._tag).toBe("BinaryFileResult");
      if (data._tag === "BinaryFileResult") {
        expect(JSON.parse(Buffer.from(data.base64, "base64").toString()).traceEvents).toHaveLength(2);
        expect(data.eventCount).toBe(2);
      }
      expect(detach).toHaveBeenCalledTimes(1);
    });

    it("HAR start clears prior requests and stop exports captured requests", async () => {
      const handlers = new Map<string, (value: unknown) => void>();
      page = mockPage({
        on: mock((event: string, handler: (value: unknown) => void) => {
          handlers.set(event, handler);
          return page;
        }) as Page["on"],
      });
      ctx = mockContext([page]);
      await executeCommand(ctx, { action: "har_start" }, refStore, SESSION);
      handlers.get("request")?.({
        url: () => "https://example.com/api",
        method: () => "POST",
        resourceType: () => "fetch",
        headers: () => ({ "content-type": "application/json" }),
        postData: () => "{}",
      });

      const data = assertOk(await executeCommand(ctx, { action: "har_stop" }, refStore, SESSION));

      expect(data._tag).toBe("BinaryFileResult");
      if (data._tag === "BinaryFileResult") {
        const har = JSON.parse(Buffer.from(data.base64, "base64").toString());
        expect(data.requestCount).toBe(1);
        expect(har.log.version).toBe("1.2");
        expect(har.log.entries[0].request.url).toBe("https://example.com/api");
      }
    });
  });

  // ─── Tab actions → TabResult ───

  describe("tab management", () => {
    it("tab_list returns TabResult", async () => {
      const r = await executeCommand(ctx, { action: "tab_list" }, refStore, SESSION);
      const data = assertOk(r);
      expect(data._tag).toBe("TabResult");
      if (data._tag === "TabResult") {
        expect(data.tabs.length).toBeGreaterThan(0);
      }
    });

    it("tab_new returns TabResult", async () => {
      const r = await executeCommand(ctx, { action: "tab_new" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("TabResult");
    });

    it("window_new creates and activates the new page", async () => {
      const pages = [mockPage({ url: mock(() => "https://first.example") })];
      const newPage = mockPage({
        url: mock(() => "about:blank"),
        title: mock(() => Promise.resolve("")),
      });
      const multiCtx = mockContext(pages, {
        newPage: mock(async () => {
          pages.push(newPage);
          return newPage;
        }),
      });

      const data = assertOk(await executeCommand(multiCtx, { action: "window_new" }, refStore, SESSION));

      expect(data._tag).toBe("TabResult");
      if (data._tag === "TabResult") {
        expect(data.tabs).toHaveLength(2);
        expect(data.tabs[0].active).toBe(false);
        expect(data.tabs[1]).toMatchObject({ index: 1, url: "about:blank", active: true });
      }
      const next = assertOk(await executeCommand(multiCtx, { action: "tab_list" }, refStore, SESSION));
      expect(next._tag).toBe("TabResult");
      if (next._tag === "TabResult") expect(next.tabs[1].active).toBe(true);
    });

    it("tab_switch returns TabResult", async () => {
      const r = await executeCommand(ctx, { action: "tab_switch", index: 0 }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("TabResult");
    });

    it("tab_switch rejects an unknown index instead of silently using page zero", async () => {
      const error = assertErr(await executeCommand(ctx, {
        action: "tab_switch",
        index: 9,
      }, refStore, SESSION));
      expect(error).toEqual({ _tag: "CommandFailed", message: "Unknown tab index: 9" });
    });

    it("tab_close returns TabResult", async () => {
      const pages = [mockPage(), mockPage()];
      const multiCtx = mockContext(pages);
      const r = await executeCommand(multiCtx, { action: "tab_close", index: 1 }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("TabResult");
    });
  });

  // ─── Cookie actions ───

  describe("cookies", () => {
    it("cookies_get returns CookiesResult", async () => {
      const r = await executeCommand(ctx, { action: "cookies_get" }, refStore, SESSION);
      const data = assertOk(r);
      expect(data._tag).toBe("CookiesResult");
      if (data._tag === "CookiesResult") {
        expect(data.cookies.length).toBe(1);
        expect(data.cookies[0].name).toBe("sid");
      }
    });

    it("cookies_clear returns VoidResult", async () => {
      const r = await executeCommand(ctx, { action: "cookies_clear" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
    });

    it("cookies_set with url does not also send domain or path", async () => {
      const r = await executeCommand(ctx, {
        action: "cookies_set",
        cookies: [{ name: "audit", value: "ok", url: "https://example.com" }],
      }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
      expect(ctx.addCookies).toHaveBeenCalledWith([{
        name: "audit",
        value: "ok",
        url: "https://example.com",
      }]);
    });

    it("cookies_set without scope uses the active page URL", async () => {
      const r = await executeCommand(ctx, {
        action: "cookies_set",
        cookies: [{ name: "audit", value: "ok" }],
      }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
      expect(ctx.addCookies).toHaveBeenCalledWith([{
        name: "audit",
        value: "ok",
        url: "https://example.com",
      }]);
    });

    it("cookies_set preserves optional cookie attributes", async () => {
      const r = await executeCommand(ctx, {
        action: "cookies_set",
        cookies: [{
          name: "audit",
          value: "ok",
          domain: ".example.com",
          path: "/audit",
          httpOnly: true,
          secure: true,
          sameSite: "Strict",
          expires: 2_000_000_000,
        }],
      }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
      expect(ctx.addCookies).toHaveBeenCalledWith([{
        name: "audit",
        value: "ok",
        domain: ".example.com",
        path: "/audit",
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        expires: 2_000_000_000,
      }]);
    });
  });

  // ─── Error mapping ───

  describe("error mapping", () => {
    it("TimeoutError with locator message → ElementNotFound", async () => {
      const err = new Error("waiting for locator('button')");
      err.name = "TimeoutError";
      const failPage = mockPage({ goto: mock(() => Promise.reject(err)) });
      const failCtx = mockContext([failPage]);
      const r = await executeCommand(failCtx, { action: "navigate", url: "https://x.com" }, refStore, SESSION);
      const e = assertErr(r);
      expect(e._tag).toBe("ElementNotFound");
    });

    it("TimeoutError without locator → Timeout", async () => {
      const err = new Error("Navigation timeout 30000ms exceeded");
      err.name = "TimeoutError";
      const failPage = mockPage({ goto: mock(() => Promise.reject(err)) });
      const failCtx = mockContext([failPage]);
      const r = await executeCommand(failCtx, { action: "navigate", url: "https://x.com" }, refStore, SESSION);
      const e = assertErr(r);
      expect(e._tag).toBe("Timeout");
    });

    it("Target closed → CdpDisconnected", async () => {
      const failPage = mockPage({ goto: mock(() => Promise.reject(new Error("Target closed"))) });
      const failCtx = mockContext([failPage]);
      const r = await executeCommand(failCtx, { action: "navigate", url: "https://x.com" }, refStore, SESSION);
      const e = assertErr(r);
      expect(e._tag).toBe("CdpDisconnected");
    });

    it("Execution context destroyed → CdpDisconnected", async () => {
      const failPage = mockPage({ goto: mock(() => Promise.reject(new Error("Execution context destroyed"))) });
      const failCtx = mockContext([failPage]);
      const r = await executeCommand(failCtx, { action: "navigate", url: "https://x.com" }, refStore, SESSION);
      const e = assertErr(r);
      expect(e._tag).toBe("CdpDisconnected");
    });

    it("generic error → CommandFailed", async () => {
      const failPage = mockPage({ goto: mock(() => Promise.reject(new Error("Something broke"))) });
      const failCtx = mockContext([failPage]);
      const r = await executeCommand(failCtx, { action: "navigate", url: "https://x.com" }, refStore, SESSION);
      const e = assertErr(r);
      expect(e._tag).toBe("CommandFailed");
    });
  });
});
