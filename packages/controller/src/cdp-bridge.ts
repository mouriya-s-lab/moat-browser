import type { BrowserCommand, BrowserResult, GatewayError } from "@moat-browser/types";
import { exhaustive } from "@moat-browser/types";

// Patchright types — imported dynamically since Patchright requires Node.js runtime
type Browser = import("patchright").Browser;
type BrowserContext = import("patchright").BrowserContext;
type Page = import("patchright").Page;

export interface CdpConnection {
  readonly browser: Browser;
  readonly context: BrowserContext;
  page: Page;
}

type CdpError = { readonly _tag: "ContainerError"; readonly message: string };

export async function connectCdp(
  cdpUrl: string
): Promise<CdpConnection | CdpError> {
  try {
    const { chromium } = await import("patchright");
    const browser = await chromium.connectOverCDP(cdpUrl);
    const contexts = browser.contexts();
    const context = contexts[0] ?? (await browser.newContext());
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    return { browser, context, page };
  } catch (err) {
    return {
      _tag: "ContainerError",
      message: `CDP connection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function getTabInfo(
  context: BrowserContext
): Promise<ReadonlyArray<{ index: number; url: string; title: string }>> {
  const pages = context.pages();
  const tabs = [];
  for (let i = 0; i < pages.length; i++) {
    tabs.push({
      index: i,
      url: pages[i].url(),
      title: await pages[i].title(),
    });
  }
  return tabs;
}

export async function executeCommand(
  conn: CdpConnection,
  command: BrowserCommand
): Promise<BrowserResult | GatewayError> {
  try {
    switch (command._tag) {
      case "Navigate": {
        await conn.page.goto(command.url, { waitUntil: "domcontentloaded" });
        return {
          _tag: "NavigateResult",
          url: conn.page.url(),
          title: await conn.page.title(),
        };
      }
      case "Click": {
        await conn.page.locator(command.selector).click();
        return { _tag: "ClickResult" };
      }
      case "Fill": {
        await conn.page.locator(command.selector).fill(command.value);
        return { _tag: "FillResult" };
      }
      case "Snapshot": {
        const aria = await conn.page.locator("body").ariaSnapshot();
        return { _tag: "SnapshotResult", aria };
      }
      case "Screenshot": {
        const buffer = await conn.page.screenshot({ type: "png" });
        return { _tag: "ScreenshotResult", png: buffer.toString("base64") };
      }
      case "Evaluate": {
        const value = await conn.page.evaluate(command.expression);
        return { _tag: "EvaluateResult", value };
      }
      case "NewTab": {
        const newPage = await conn.context.newPage();
        if (command.url) await newPage.goto(command.url);
        conn.page = newPage;
        return { _tag: "TabResult", tabs: await getTabInfo(conn.context) };
      }
      case "SwitchTab": {
        const pages = conn.context.pages();
        if (command.index < 0 || command.index >= pages.length) {
          return {
            _tag: "CommandError",
            command: "SwitchTab",
            message: `Tab index ${command.index} out of range (0-${pages.length - 1})`,
          };
        }
        conn.page = pages[command.index];
        await conn.page.bringToFront();
        return { _tag: "TabResult", tabs: await getTabInfo(conn.context) };
      }
      case "CloseTab": {
        const allPages = conn.context.pages();
        if (command.index < 0 || command.index >= allPages.length) {
          return {
            _tag: "CommandError",
            command: "CloseTab",
            message: `Tab index ${command.index} out of range (0-${allPages.length - 1})`,
          };
        }
        await allPages[command.index].close();
        const remaining = conn.context.pages();
        conn.page =
          remaining[Math.min(command.index, remaining.length - 1)] ??
          (await conn.context.newPage());
        return { _tag: "TabResult", tabs: await getTabInfo(conn.context) };
      }
      case "Wait": {
        await conn.page.locator(command.selector).waitFor({
          timeout: command.timeout ?? 30000,
        });
        return { _tag: "WaitResult" };
      }
      default:
        return exhaustive(command);
    }
  } catch (err) {
    return {
      _tag: "CommandError",
      command: command._tag,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function disconnectCdp(conn: CdpConnection): Promise<void> {
  try {
    await conn.browser.close();
  } catch {
    // Best effort
  }
}
