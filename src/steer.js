import { DEVELOPER_AGENT, STEERING_TOOL_ACCESS, STEERING_TOOLS } from "./agents.js";
import { createStateService } from "./state.js";

// Native /steer command owned by the installer. The hook in this module is
// the sole writer: it calls the existing state service directly so validation
// plus journaling stay identical to the submit tool with no parallel store.
export const STEER_COMMAND_NAME = "steer";
export const STEER_COMMAND_AGENT = DEVELOPER_AGENT;
export const STEER_COMMAND_DESCRIPTION =
  "Submit bounded Developer steering for one Plan ID target (Developer only; flock roles denied).";
export const STEER_COMMAND_TEMPLATE =
  "Submit Developer steering with arguments: $ARGUMENTS\n\nFormat $ARGUMENTS as `<content>` or `<planId> :: <content>`; omit planId only when exactly one active steering target exists.";

export function steerCommandEntry() {
  return {
    template: STEER_COMMAND_TEMPLATE,
    description: STEER_COMMAND_DESCRIPTION,
    agent: STEER_COMMAND_AGENT,
  };
}

// Parse /steer arguments into the exact { content plus optional planId }
// shape the state service validates. `::` separates an explicit planId
// candidate from content when the left side is a single token (no whitespace);
// the candidate is passed through so the state service reports
// INVALID_PLAN_ID identically to the submit tool. A left side with whitespace
// is prose, so the whole string stays content and `::` inside sentences never
// misroutes.
export function parseSteerArguments(rawArguments) {
  const raw = typeof rawArguments === "string" ? rawArguments : "";
  const separator = raw.indexOf("::");
  if (separator !== -1) {
    const left = raw.slice(0, separator).trim();
    const right = raw.slice(separator + 2).trim();
    if (left.length > 0 && !/\s/.test(left)) {
      return { planId: left, content: right };
    }
  }
  return { content: raw.trim() };
}

// Single shared allowlist with the submit tool: only the explicit developer
// context passes. All seven orchestration roles plus unknown plus none plus
// unset fail closed.
export function isSteerAllowedAgent(agent) {
  return STEERING_TOOL_ACCESS.get(STEERING_TOOLS.submit)?.has(agent) === true;
}

// Resolve the session agent via the SDK client, fail closed to undefined on
// any unresolvable shape. Prefers session messages (UserMessage.agent) then
// falls back to session get; any throw or missing agent is unresolvable.
export async function resolveSessionAgentViaClient(client, sessionID) {
  if (!client || typeof sessionID !== "string" || sessionID.length === 0) return undefined;
  try {
    const session = client?.session;
    if (!session) return undefined;
    if (typeof session.messages === "function") {
      const result = await session.messages({ path: { id: sessionID } });
      const data = result?.data ?? result;
      if (Array.isArray(data)) {
        for (let index = data.length - 1; index >= 0; index -= 1) {
          const agent = data[index]?.info?.agent;
          if (typeof agent === "string" && agent.length > 0) return agent;
        }
      }
    }
    if (typeof session.get === "function") {
      const result = await session.get({ path: { id: sessionID } });
      const data = result?.data ?? result;
      const agent = data?.agent ?? data?.info?.agent;
      if (typeof agent === "string" && agent.length > 0) return agent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function pushPart(output, text) {
  const part = { type: "text", text };
  if (output && Array.isArray(output.parts)) {
    output.parts.push(part);
    return;
  }
  if (output && output.parts === undefined) {
    output.parts = [part];
  }
}

// command.execute.before intercept for /steer. Performs the write directly
// through the existing state service, enforces the shared Developer-only
// allowlist, then throws to abort before any model turn. The throw carries
// the confirmation (steering id plus resolved target); output.parts carries
// the same text as a minimal fallback if error styling is unacceptable.
export function createSteerCommandHook({ client, stateOptions = {}, resolveAgent } = {}) {
  const resolve = resolveAgent ?? ((sessionID) => resolveSessionAgentViaClient(client, sessionID));
  return async function steerCommandBefore(input, output) {
    if (!input || input.command !== STEER_COMMAND_NAME) return;
    let agent;
    try {
      agent = await resolve(input.sessionID);
    } catch {
      agent = undefined;
    }
    if (typeof agent !== "string" || !isSteerAllowedAgent(agent)) {
      const denial = `Steering denied: agent ${JSON.stringify(agent ?? "unknown")} may not use /${STEER_COMMAND_NAME}. Developer context only.`;
      pushPart(output, denial);
      throw new Error(denial);
    }
    const parsed = parseSteerArguments(input.arguments);
    const state = createStateService(stateOptions);
    const payload =
      parsed.planId === undefined ? { content: parsed.content } : { planId: parsed.planId, content: parsed.content };
    const result = await state.submitSteering(payload);
    if (!result.ok) {
      const failure = `Steering failed [${result.error.code}]: ${result.error.message}`;
      pushPart(output, failure);
      throw new Error(failure);
    }
    const confirmation = `Steering recorded: ${result.entry.id} for target ${result.entry.planId}#${result.entry.sequence}`;
    pushPart(output, confirmation);
    throw new Error(confirmation);
  };
}
