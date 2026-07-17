import { describe, expect, it, mock, beforeEach } from "bun:test";
import type { BrowserContext, Locator, Page, Response } from "patchright";
import type { BrowserCommand, CookieEntry } from "@moat-browser/types";
import { executeCommand, type Result } from "./cdp-bridge.js";
import type { RefStore } from "./ref-store.js";
import type { ControllerError, CommandResultData } from "@moat-browser/types";

// ─── Mock helpers ───

function mockLocator(overrides?: Partial<Locator>): Locator {
  return {
    click: mock(() => Promise.resolve()),
    fill: mock((_v: string) => Promise.resolve()),
    pressSequentially: mock((_v: string) => Promise.resolve()),
    check: mock(() => Promise.resolve()),
    uncheck: mock(() => Promise.resolve()),
    hover: mock(() => Promise.resolve()),
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
    nth: mock(function (this: Locator) { return this; }),
    ...overrides,
  } as unknown as Locator;
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
    evaluate: mock((_code: unknown) => Promise.resolve({ answer: 42 })),
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
    ariaSnapshot: mock(() => Promise.resolve('- heading "Test"\n- button "Click me"')),
    close: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as Page;
}

function mockContext(pages: Page[]): BrowserContext {
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
    clearCookies: mock(() => Promise.resolve()),
    addCookies: mock(() => Promise.resolve()),
    setGeolocation: mock(() => Promise.resolve()),
    setOffline: mock(() => Promise.resolve()),
    setHTTPCredentials: mock(() => Promise.resolve()),
    newCDPSession: mock(() => Promise.resolve({
      send: mock(() => Promise.resolve()),
      detach: mock(() => Promise.resolve()),
    })),
  } as unknown as BrowserContext;
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

describe("cdp-bridge", () => {
  let page: Page;
  let ctx: BrowserContext;
  let refStore: RefStore;

  beforeEach(() => {
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

    it("eval returns EvalResult with JSON.stringify'd value", async () => {
      const r = await executeCommand(ctx, { action: "eval", code: "1+1" }, refStore, SESSION);
      const data = assertOk(r);
      expect(data._tag).toBe("EvalResult");
      if (data._tag === "EvalResult") {
        expect(data.result).toBe('{"answer":42}');
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
      expect(data).toEqual({ _tag: "BoundingBoxResult", box: { x: 1, y: 2, width: 3, height: 4 } });
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

    it("scroll returns VoidResult", async () => {
      const r = await executeCommand(ctx, { action: "scroll", direction: "down" }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("VoidResult");
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

    it("viewport applies dimensions and device scale factor", async () => {
      const data = assertOk(await executeCommand(ctx, {
        action: "viewport",
        width: 800,
        height: 600,
        deviceScaleFactor: 2,
      }, refStore, SESSION));
      expect(data._tag).toBe("VoidResult");
      expect(page.setViewportSize).toHaveBeenCalledWith({ width: 800, height: 600 });
      expect(ctx.newCDPSession).toHaveBeenCalledWith(page);
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

    it("tab_switch returns TabResult", async () => {
      const r = await executeCommand(ctx, { action: "tab_switch", index: 0 }, refStore, SESSION);
      expect(assertOk(r)._tag).toBe("TabResult");
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
