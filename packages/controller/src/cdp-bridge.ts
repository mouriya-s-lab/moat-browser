/**
 * cdp-bridge.ts — Patchright CDP Bridge
 *
 * Connects to agent-chrome via Patchright connectOverCDP and executes
 * BrowserCommands, returning BrowserResults or GatewayErrors.
 */

import { chromium } from "patchright";
import type { Browser, BrowserContext, Page } from "patchright";
import type { BrowserCommand, BrowserResult, GatewayError } from "@moat-browser/types";
import { exhaustive } from "@moat-browser/types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CDP_HOST = process.env["CDP_HOST"] ?? "127.0.0.1";
const CDP_PORT = parseInt(process.env["CDP_PORT"] ?? "9222", 10);

// ---------------------------------------------------------------------------
// CDPConnection
// ---------------------------------------------------------------------------

interface CDPConnection {
  readonly browser: Browser;
  readonly context: BrowserContext;
  activePage: Page;
  readonly pages: Map<string, Page>;
}

// ---------------------------------------------------------------------------
// CDPBridge
// ---------------------------------------------------------------------------

export class CDPBridge {
  private conn: CDPConnection | null = null;
  private disconnectCallback: ((reason: string) => void) | null = null;

  /**
   * Connect to agent-chrome CDP endpoint.
   * Resolves when connected and at least one page is available.
   */
  async connect(
    host: string = CDP_HOST,
    port: number = CDP_PORT,
    onDisconnect?: (reason: string) => void
  ): Promise<void> {
    if (this.conn !== null) {
      throw new Error("CDPBridge: already connected");
    }

    const browser = await chromium.connectOverCDP(`http://${host}:${port}`);

    this.disconnectCallback = onDisconnect ?? null;

    browser.on("disconnected", () => {
      this.conn = null;
      if (this.disconnectCallback) {
        this.disconnectCallback("CDP browser disconnected");
      }
    });

    // Use existing context or create one
    let context: BrowserContext;
    if (browser.contexts().length > 0) {
      context = browser.contexts()[0]!;
    } else {
      context = await browser.newContext();
    }

    // Use existing page or create one
    let activePage: Page;
    if (context.pages().length > 0) {
      activePage = context.pages()[0]!;
    } else {
      activePage = await context.newPage();
    }

    const pages = new Map<string, Page>();
    // Register all existing pages by index-based tabId
    for (let i = 0; i < context.pages().length; i++) {
      const page = context.pages()[i];
      if (page !== undefined) {
        pages.set(String(i), page);
      }
    }
    // Ensure activePage is registered
    if (!pages.has("0")) {
      pages.set("0", activePage);
    }

    this.conn = { browser, context, activePage, pages };
  }

  /** Disconnect from CDP. */
  async disconnect(): Promise<void> {
    if (this.conn !== null) {
      await this.conn.browser.close();
      this.conn = null;
    }
  }

  /** Whether the bridge is currently connected. */
  get connected(): boolean {
    return this.conn !== null;
  }

  /**
   * Execute a BrowserCommand.
   * Returns Ok result or GatewayError discriminated union.
   */
  async execute(
    command: BrowserCommand
  ): Promise<BrowserResult | GatewayError> {
    if (this.conn === null) {
      return {
        _tag: "CDPError",
        message: "CDPBridge: not connected",
      } satisfies GatewayError;
    }

    try {
      return await this._dispatch(this.conn, command);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        _tag: "CommandError",
        command: command._tag,
        message,
      } satisfies GatewayError;
    }
  }

  private async _dispatch(
    conn: CDPConnection,
    command: BrowserCommand
  ): Promise<BrowserResult> {
    switch (command._tag) {
      case "Navigate": {
        const response = await conn.activePage.goto(command.url, {
          waitUntil: "domcontentloaded",
        });
        const url = response?.url() ?? conn.activePage.url();
        const title = await conn.activePage.title();
        return { _tag: "NavigateResult", url, title } satisfies BrowserResult;
      }

      case "Click": {
        await conn.activePage.locator(command.ref).click();
        return { _tag: "ClickResult", ref: command.ref } satisfies BrowserResult;
      }

      case "Fill": {
        await conn.activePage.locator(command.ref).fill(command.value);
        return { _tag: "FillResult", ref: command.ref } satisfies BrowserResult;
      }

      case "Snapshot": {
        // ariaSnapshot() returns a YAML-formatted ARIA accessibility tree —
        // this is the structured page representation (not raw DOM).
        const snapshotStr = await conn.activePage.ariaSnapshot();
        return { _tag: "SnapshotResult", snapshot: snapshotStr } satisfies BrowserResult;
      }

      case "Screenshot": {
        const buf = await conn.activePage.screenshot({ type: "png" });
        const b64 = buf.toString("base64");
        const dataUrl = `data:image/png;base64,${b64}`;
        return { _tag: "ScreenshotResult", dataUrl } satisfies BrowserResult;
      }

      case "Evaluate": {
        const value = await conn.activePage.evaluate(command.expression);
        return { _tag: "EvaluateResult", value } satisfies BrowserResult;
      }

      case "NewTab": {
        const page = await conn.context.newPage();
        if (command.url !== undefined) {
          await page.goto(command.url, { waitUntil: "domcontentloaded" });
        }
        const tabId = String(conn.pages.size);
        conn.pages.set(tabId, page);
        conn.activePage = page;
        const url = page.url();
        return { _tag: "NewTabResult", tabId, url } satisfies BrowserResult;
      }

      case "SwitchTab": {
        const page = conn.pages.get(command.tabId);
        if (page === undefined) {
          throw new Error(`Tab not found: ${command.tabId}`);
        }
        conn.activePage = page;
        await page.bringToFront();
        return { _tag: "SwitchTabResult", tabId: command.tabId } satisfies BrowserResult;
      }

      case "CloseTab": {
        const page = conn.pages.get(command.tabId);
        if (page === undefined) {
          throw new Error(`Tab not found: ${command.tabId}`);
        }
        conn.pages.delete(command.tabId);
        // Switch to first remaining page if this was active
        if (conn.activePage === page) {
          const remaining = conn.context.pages().filter((p) => p !== page);
          if (remaining.length > 0) {
            conn.activePage = remaining[0]!;
          } else {
            // Create a new page to avoid empty context
            conn.activePage = await conn.context.newPage();
            conn.pages.set("0", conn.activePage);
          }
        }
        await page.close();
        return { _tag: "CloseTabResult", tabId: command.tabId } satisfies BrowserResult;
      }

      case "Wait": {
        await new Promise<void>((resolve) => setTimeout(resolve, command.ms));
        return { _tag: "WaitResult", ms: command.ms } satisfies BrowserResult;
      }

      default:
        return exhaustive(command);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and connect a CDPBridge.
 * onDisconnect is called when the browser disconnects unexpectedly.
 */
export async function createCDPBridge(
  host?: string,
  port?: number,
  onDisconnect?: (reason: string) => void
): Promise<CDPBridge> {
  const bridge = new CDPBridge();
  await bridge.connect(host, port, onDisconnect);
  return bridge;
}
