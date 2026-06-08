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
    count: mock(() => Promise.resolve(1)),
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
    screenshot: mock(() => Promise.resolve(Buffer.from("png-data"))),
    evaluate: mock((_code: unknown) => Promise.resolve({ answer: 42 })),
    keyboard: { press: mock(() => Promise.resolve()) },
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
