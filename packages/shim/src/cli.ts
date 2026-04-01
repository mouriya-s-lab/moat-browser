#!/usr/bin/env bun
// moat-browser-shim CLI — daemon and exec subcommands (design.md §6.1)
import { loadConfig } from "./config.js";
import { runDaemon } from "./daemon.js";
import { MoatBrowserClient } from "./client.js";
import { BrowserCommandSchema } from "@moat-browser/types";
import { type } from "arktype";

function printUsage(): void {
  console.error(`
Usage: moat-browser-shim <subcommand> [options]

Subcommands:
  daemon    Start daemon mode (Unix socket, JSON-line protocol)
  exec      Execute a single browser command and exit

Options for daemon:
  --gateway <url>     Controller Socket.IO URL (or MOAT_BROWSER_GATEWAY)
  --token <jwt>       JWT token (or MOAT_BROWSER_TOKEN)
  --agent-id <id>     Agent ID (or MOAT_BROWSER_AGENT_ID)
  --socket <path>     Unix socket path (or MOAT_BROWSER_SOCKET, default: /run/agent-browser/main.sock)

Options for exec:
  --gateway <url>     (same as above)
  --token <jwt>
  --agent-id <id>
  --command <json>    BrowserCommand ADT as JSON string
`);
}

// Minimal arg parser — returns a map of --flag → value
function parseArgs(argv: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        result.set(key, val);
        i++;
      } else {
        result.set(key, "true");
      }
    }
  }
  return result;
}

function getOpt(
  flags: Map<string, string>,
  envKey: string,
  flagKey: string,
  required: true
): string;
function getOpt(
  flags: Map<string, string>,
  envKey: string,
  flagKey: string,
  required: false,
  defaultVal: string
): string;
function getOpt(
  flags: Map<string, string>,
  envKey: string,
  flagKey: string,
  required: boolean,
  defaultVal?: string
): string {
  const val = flags.get(flagKey) ?? process.env[envKey] ?? defaultVal;
  if (!val && required) {
    console.error(`Error: --${flagKey} or ${envKey} is required`);
    process.exit(1);
  }
  return val as string;
}

async function cmdDaemon(flags: Map<string, string>): Promise<void> {
  const gateway = getOpt(flags, "MOAT_BROWSER_GATEWAY", "gateway", true);
  const token = getOpt(flags, "MOAT_BROWSER_TOKEN", "token", true);
  const agentId = getOpt(flags, "MOAT_BROWSER_AGENT_ID", "agent-id", true);
  const socketPath = getOpt(
    flags,
    "MOAT_BROWSER_SOCKET",
    "socket",
    false,
    "/run/agent-browser/main.sock"
  );

  await runDaemon({ gateway, token, agentId, socketPath });
}

async function cmdExec(flags: Map<string, string>): Promise<void> {
  const gateway = getOpt(flags, "MOAT_BROWSER_GATEWAY", "gateway", true);
  const token = getOpt(flags, "MOAT_BROWSER_TOKEN", "token", true);
  const agentId = getOpt(flags, "MOAT_BROWSER_AGENT_ID", "agent-id", true);
  const commandJson = flags.get("command");

  if (!commandJson) {
    console.error("Error: --command <json> is required for exec subcommand");
    process.exit(1);
  }

  let rawCmd: unknown;
  try {
    rawCmd = JSON.parse(commandJson);
  } catch {
    console.error("Error: --command value is not valid JSON");
    process.exit(1);
  }

  const parsed = BrowserCommandSchema(rawCmd);
  if (parsed instanceof type.errors) {
    console.error("Error: invalid BrowserCommand:", parsed.summary);
    process.exit(1);
  }

  const client = new MoatBrowserClient({ gateway, token, agentId });

  const connectResult = await client.connect();
  if ("_tag" in connectResult && isGatewayError(connectResult)) {
    console.error("Error: connect failed:", JSON.stringify(connectResult));
    process.exit(1);
  }

  const result = await client.command(parsed);
  console.log(JSON.stringify(result, null, 2));

  await client.disconnect();
  process.exit(0);
}

function isGatewayError(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    "_tag" in v &&
    [
      "AuthenticationFailed",
      "SessionNotFound",
      "SessionNotReady",
      "ContainerError",
      "CDPError",
      "InternalError",
    ].includes((v as { _tag: string })._tag)
  );
}

// ---- Main ----

const [, , subcommand, ...rest] = process.argv;
const flags = parseArgs(rest ?? []);

switch (subcommand) {
  case "daemon":
    cmdDaemon(flags).catch((err: unknown) => {
      console.error("[daemon] Fatal:", err);
      process.exit(1);
    });
    break;

  case "exec":
    cmdExec(flags).catch((err: unknown) => {
      console.error("[exec] Fatal:", err);
      process.exit(1);
    });
    break;

  default:
    printUsage();
    process.exit(1);
}
