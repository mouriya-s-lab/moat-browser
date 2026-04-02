import { chromium } from "patchright";
import type { Browser, Page } from "patchright";
import type { BrowserCommand, BrowserResult, CommandError } from "@moat-browser/types";
import { exhaustive } from "@moat-browser/types";

type CdpResult = BrowserResult | CommandError;

export interface CdpConnection {
  readonly browser: Browser;
  page: Page;
}

type ConnectResult =
  | { readonly _tag: "CdpOk"; readonly connection: CdpConnection }
  | CommandError;

export async function connectCDP(ip: string): Promise<ConnectResult> {
  try {
    const browser = await chromium.connectOverCDP(`http://${ip}:9222`);
    const contexts = browser.contexts();
    const context = contexts[0] ?? await browser.newContext();
    const pages = context.pages();
    const page = pages[0] ?? await context.newPage();
    return { _tag: "CdpOk", connection: { browser, page } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { _tag: "CommandError", command: "connectCDP", message };
  }
}

export async function executeCommand(
  conn: CdpConnection,
  command: BrowserCommand
): Promise<CdpResult> {
  try {
    switch (command._tag) {
      case "Navigate": {
        await conn.page.goto(command.url, { waitUntil: "domcontentloaded" });
        const title = await conn.page.title();
        const url = conn.page.url();
        return { _tag: "NavigateResult", url, title };
      }

      case "Click": {
        await conn.page.click(command.selector);
        return { _tag: "ClickResult" };
      }

      case "Fill": {
        await conn.page.fill(command.selector, command.value);
        return { _tag: "FillResult" };
      }

      case "Snapshot": {
        const aria = await conn.page.ariaSnapshot();
        return { _tag: "SnapshotResult", aria };
      }

      case "Screenshot": {
        const buffer = await conn.page.screenshot({ type: "png" });
        const png = Buffer.from(buffer).toString("base64");
        return { _tag: "ScreenshotResult", png };
      }

      case "Evaluate": {
        const value = await conn.page.evaluate(command.expression);
        return { _tag: "EvaluateResult", value };
      }

      case "NewTab": {
        const context = conn.page.context();
        const newPage = await context.newPage();
        if (command.url) {
          await newPage.goto(command.url, { waitUntil: "domcontentloaded" });
        }
        conn.page = newPage;
        const tabs = context.pages().map((p, i) => ({
          index: i,
          url: p.url(),
          title: "",
        }));
        return { _tag: "TabResult", tabs };
      }

      case "SwitchTab": {
        const context = conn.page.context();
        const pages = context.pages();
        const target = pages[command.index];
        if (!target) {
          return { _tag: "CommandError", command: "SwitchTab", message: `tab ${command.index} not found` };
        }
        conn.page = target;
        await target.bringToFront();
        const tabs = pages.map((p, i) => ({
          index: i,
          url: p.url(),
          title: "",
        }));
        return { _tag: "TabResult", tabs };
      }

      case "CloseTab": {
        const context = conn.page.context();
        const pages = context.pages();
        const target = pages[command.index];
        if (!target) {
          return { _tag: "CommandError", command: "CloseTab", message: `tab ${command.index} not found` };
        }
        await target.close();
        const remaining = context.pages();
        if (remaining.length === 0) {
          conn.page = await context.newPage();
        } else if (conn.page === target) {
          conn.page = remaining[0]!;
        }
        const tabs = context.pages().map((p, i) => ({
          index: i,
          url: p.url(),
          title: "",
        }));
        return { _tag: "TabResult", tabs };
      }

      case "Wait": {
        await conn.page.waitForSelector(command.selector, {
          timeout: command.timeout ?? 30000,
        });
        return { _tag: "WaitResult" };
      }

      default:
        return exhaustive(command);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { _tag: "CommandError", command: command._tag, message };
  }
}
