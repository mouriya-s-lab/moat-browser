import type { Socket } from "socket.io";
import {
  type ClientEvent,
  type ServerEvent,
  type GatewayError,
  ClientEventSchema,
  exhaustive,
} from "@moat-browser/types";
import { sendToController } from "./controller-client.js";
import * as sessionMgr from "./session.js";
import { checkUrl } from "./acl.js";
import { checkBudget, clearBudget } from "./budget.js";
import { config } from "./config.js";

function errorEvent(error: GatewayError): ServerEvent {
  return { _tag: "Error", error };
}

export async function handleClientEvent(
  socket: Socket,
  raw: unknown
): Promise<ServerEvent> {
  const parsed = ClientEventSchema(raw);
  if (parsed instanceof Array) {
    return errorEvent({ _tag: "InternalError", message: `Invalid message: ${parsed[0]}` });
  }

  const event = parsed as ClientEvent;

  switch (event._tag) {
    case "Register":
      return handleRegister(socket, event);
    case "Deregister":
      return handleDeregister(event);
    case "Command":
      return handleCommand(event);
    case "StartUserChrome":
      return handleStartUserChrome(event);
    case "StopUserChrome":
      return handleStopUserChrome();
    case "FreezeProfile":
      return handleFreezeProfile(event);
    case "ListProfiles":
      return handleListProfiles();
    case "Ping":
      return { _tag: "Pong" };
    default:
      return exhaustive(event);
  }
}

async function handleRegister(
  socket: Socket,
  event: Extract<ClientEvent, { _tag: "Register" }>
): Promise<ServerEvent> {
  // Check if agent already has a session
  const existing = sessionMgr.getSessionByAgent(event.agentId);
  if (existing) {
    return errorEvent({ _tag: "AgentAlreadyRegistered", agentId: event.agentId });
  }

  // Ask controller to create agent browser
  const result = await sendToController({
    _tag: "CreateAgentBrowser",
    agentId: event.agentId,
    profileName: event.profile,
  });

  if (result._tag !== "AgentBrowserCreated") {
    return errorEvent({ _tag: "ContainerError", message: `Controller: ${result._tag}` });
  }

  const session = sessionMgr.createSession(
    event.agentId,
    event.profile,
    result.containerId,
    result.socketPath,
    socket.id,
  );

  socket.join(session.sessionId);

  return {
    _tag: "Registered",
    sessionId: session.sessionId,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

async function handleDeregister(
  event: Extract<ClientEvent, { _tag: "Deregister" }>
): Promise<ServerEvent> {
  const session = sessionMgr.getSession(event.sessionId);
  if (!session) {
    return errorEvent({ _tag: "SessionNotFound", sessionId: event.sessionId });
  }

  // Destroy container
  await sendToController({
    _tag: "DestroyAgentBrowser",
    agentId: session.agentId,
  });

  sessionMgr.removeSession(event.sessionId);
  clearBudget(event.sessionId);

  return { _tag: "Deregistered", sessionId: event.sessionId };
}

async function handleCommand(
  event: Extract<ClientEvent, { _tag: "Command" }>
): Promise<ServerEvent> {
  const session = sessionMgr.getSession(event.sessionId);
  if (!session) {
    return errorEvent({ _tag: "SessionNotFound", sessionId: event.sessionId });
  }

  if (sessionMgr.isExpired(session)) {
    sessionMgr.removeSession(event.sessionId);
    return { _tag: "SessionExpired", sessionId: event.sessionId, reason: "session timeout" };
  }

  // Budget check
  const budgetError = checkBudget(event.sessionId);
  if (budgetError) return errorEvent(budgetError);

  // ACL check for Navigate commands
  if (event.command._tag === "Navigate") {
    const aclError = checkUrl(event.command.url);
    if (aclError) return errorEvent(aclError);
  }

  // TODO: Forward command to agent-chrome container via CDP socket
  // For now, return a placeholder
  return {
    _tag: "CommandResult",
    sessionId: event.sessionId,
    result: { _tag: "CommandError", message: "Command forwarding not yet implemented" },
  };
}

async function handleStartUserChrome(
  event: Extract<ClientEvent, { _tag: "StartUserChrome" }>
): Promise<ServerEvent> {
  const result = await sendToController({
    _tag: "StartUserChrome",
    profileName: event.profileName,
  });

  if (result._tag !== "UserChromeStarted") {
    return errorEvent({ _tag: "ContainerError", message: `Controller: ${result._tag}` });
  }

  return {
    _tag: "UserChromeStarted",
    nekoUrl: `http://localhost:${result.nekoPort}`,
  };
}

async function handleStopUserChrome(): Promise<ServerEvent> {
  const result = await sendToController({ _tag: "StopUserChrome" });

  if (result._tag !== "UserChromeStopped") {
    return errorEvent({ _tag: "ContainerError", message: `Controller: ${result._tag}` });
  }

  return { _tag: "UserChromeStopped" };
}

async function handleFreezeProfile(
  event: Extract<ClientEvent, { _tag: "FreezeProfile" }>
): Promise<ServerEvent> {
  const result = await sendToController({
    _tag: "FreezeProfile",
    profileName: event.profileName,
  });

  if (result._tag !== "ProfileFrozen") {
    return errorEvent({ _tag: "ContainerError", message: `Controller: ${result._tag}` });
  }

  return {
    _tag: "ProfileFrozen",
    profileName: event.profileName,
    frozenAt: result.frozenAt,
  };
}

async function handleListProfiles(): Promise<ServerEvent> {
  const result = await sendToController({ _tag: "ListProfiles" });

  if (result._tag !== "ProfileList") {
    return errorEvent({ _tag: "ContainerError", message: `Controller: ${result._tag}` });
  }

  return { _tag: "ProfileList", profiles: result.profiles };
}
