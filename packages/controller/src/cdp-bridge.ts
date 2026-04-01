// CDP Bridge — Patchright connectOverCDP + BrowserCommand exhaustive execution
// design.md §4.5
import { chromium } from "patchright";
import type { BrowserCommand, BrowserResult, GatewayError } from "@moat-browser/types";
import { exhaustive } from "@moat-browser/types";
import type { Browser, BrowserContext, Page } from "patchright";

// CDPConnection holds the live Patchright objects for one agent
export interface CDPConnection {
  readonly browser: Browser;
  readonly context: BrowserContext;
  activePage: Page;
  readonly pages: Map<string, Page>; // tabName → Page
}

// Connect to agent-chrome container via CDP
export async function connect(
  containerIp: string
): Promise<CDPConnection | GatewayError> {
  try {
    const browser = await chromium.connectOverCDP(`http://${containerIp}:9222`);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close();
      return { _tag: "CDPError", message: "No browser context available" };
    }
    const activePage = context.pages()[0] ?? (await context.newPage());
    const pages = new Map<string, Page>();
    pages.set(await activePage.title(), activePage);
    return { browser, context, activePage, pages };
  } catch (err) {
    return { _tag: "CDPError", message: `connectOverCDP failed: ${String(err)}` };
  }
}

// Execute a BrowserCommand — exhaustive switch on all _tag variants
export async function executeCommand(
  conn: CDPConnection,
  cmd: BrowserCommand
): Promise<BrowserResult | GatewayError> {
  try {
    switch (cmd._tag) {
      case "Navigate": {
        await conn.activePage.goto(cmd.url);
        return {
          _tag: "NavigateResult",
          url: conn.activePage.url(),
          title: await conn.activePage.title(),
        };
      }

      case "Click": {
        await conn.activePage.locator(`[aria-ref="${cmd.ref}"]`).click();
        return { _tag: "ClickResult", success: true };
      }

      case "Fill": {
        await conn.activePage.locator(`[aria-ref="${cmd.ref}"]`).fill(cmd.value);
        return { _tag: "FillResult", success: true };
      }

      case "Snapshot": {
        const snapshot = await conn.activePage.accessibility.snapshot();
        return { _tag: "SnapshotResult", snapshot: JSON.stringify(snapshot) };
      }

      case "Screenshot": {
        const buf = await conn.activePage.screenshot({ type: "png" });
        const base64Png = Buffer.from(buf).toString("base64");
        return { _tag: "ScreenshotResult", base64Png };
      }

      case "Evaluate": {
        const value = await conn.activePage.evaluate(cmd.expression);
        return { _tag: "EvaluateResult", value };
      }

      case "NewTab": {
        const page = await conn.context.newPage();
        if (cmd.url) await page.goto(cmd.url);
        const tabName = await page.title();
        conn.pages.set(tabName, page);
        conn.activePage = page;
        return { _tag: "TabResult", tabName };
      }

      case "SwitchTab": {
        const page = conn.pages.get(cmd.tabName);
        if (!page) {
          return {
            _tag: "CommandError",
            message: `Tab not found: ${cmd.tabName}`,
          };
        }
        conn.activePage = page;
        await page.bringToFront();
        return { _tag: "TabResult", tabName: cmd.tabName };
      }

      case "CloseTab": {
        const page = conn.pages.get(cmd.tabName);
        if (!page) {
          return {
            _tag: "CommandError",
            message: `Tab not found: ${cmd.tabName}`,
          };
        }
        await page.close();
        conn.pages.delete(cmd.tabName);
        // Switch to first remaining page if closed page was active
        if (conn.activePage === page) {
          const remaining = conn.context.pages()[0];
          if (remaining) conn.activePage = remaining;
        }
        return { _tag: "TabResult", tabName: cmd.tabName };
      }

      case "Wait": {
        await Bun.sleep(cmd.ms);
        return { _tag: "WaitResult" };
      }

      default:
        return exhaustive(cmd);
    }
  } catch (err) {
    return { _tag: "CDPError", message: `Command ${cmd._tag} failed: ${String(err)}` };
  }
}

// Close the CDP connection and release resources
export async function disconnect(conn: CDPConnection): Promise<void> {
  try {
    await conn.browser.close();
  } catch {
    // Ignore close errors
  }
}
