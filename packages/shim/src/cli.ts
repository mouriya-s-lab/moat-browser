#!/usr/bin/env bun
/**
 * cli.ts — moat-browser-shim CLI
 *
 * Usage:
 *   # daemon mode
 *   moat-browser-shim daemon --gateway wss://... --token $TOKEN --agent-id ... --socket /run/agent-browser/main.sock
 *
 *   # single command
 *   moat-browser-shim exec --gateway wss://... --token $TOKEN --agent-id ... --command '{"_tag":"Navigate","url":"..."}'
 *
 * Environment variables (fallback):
 *   MOAT_BROWSER_GATEWAY, MOAT_BROWSER_TOKEN, MOAT_BROWSER_AGENT_ID, MOAT_BROWSER_SOCKET
 */

import { ShimDaemon } from "./daemon.js";
import { MoatBrowserClient } from "./client.js";
import { config } from "./config.js";
import type { BrowserCommand } from "@moat-browser/types";

// ---------------------------------------------------------------------------
// Argument parsing (no external deps)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== undefined && arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = "true";
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function daemonCommand(args: Record<string, string>): Promise<void> {
  const gateway = args["gateway"] ?? config.gateway;
  const token = args["token"] ?? config.token;
  const agentId = args["agent-id"] ?? config.agentId;
  const socketPath = args["socket"] ?? config.socket;

  if (!token) {
    console.error("[shim] --token or MOAT_BROWSER_TOKEN is required");
    process.exit(1);
  }
  if (!agentId) {
    console.error("[shim] --agent-id or MOAT_BROWSER_AGENT_ID is required");
    process.exit(1);
  }

  const daemon = new ShimDaemon({ gateway, token, agentId, socketPath });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[shim-daemon] received ${signal}, shutting down...`);
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await daemon.start();
  console.log("[shim-daemon] ready");
}

async function execCommand(args: Record<string, string>): Promise<void> {
  const gateway = args["gateway"] ?? config.gateway;
  const token = args["token"] ?? config.token;
  const agentId = args["agent-id"] ?? config.agentId;
  const commandStr = args["command"];

  if (!token) {
    console.error("[shim] --token or MOAT_BROWSER_TOKEN is required");
    process.exit(1);
  }
  if (!agentId) {
    console.error("[shim] --agent-id or MOAT_BROWSER_AGENT_ID is required");
    process.exit(1);
  }
  if (!commandStr) {
    console.error("[shim] --command is required");
    process.exit(1);
  }

  let cmd: BrowserCommand | undefined;
  try {
    cmd = JSON.parse(commandStr) as BrowserCommand;
  } catch {
    console.error("[shim] --command must be valid JSON");
    process.exit(1);
  }

  if (!cmd) {
    console.error("[shim] --command parse failed");
    process.exit(1);
  }

  const client = new MoatBrowserClient({ gateway, token, agentId });
  const connectResult = await client.connect();
  if ("_tag" in connectResult) {
    console.error("[shim] connection failed:", JSON.stringify(connectResult));
    process.exit(1);
  }

  const result = await client.command(cmd);
  console.log(JSON.stringify(result, null, 2));

  await client.disconnect();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (subcommand) {
    case "daemon":
      await daemonCommand(args);
      break;
    case "exec":
      await execCommand(args);
      break;
    default:
      console.error(`Usage: moat-browser-shim <daemon|exec> [options]`);
      console.error(`  daemon  Start in daemon mode (Unix socket)`);
      console.error(`  exec    Execute a single command`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("[shim] fatal error:", e);
  process.exit(1);
});
