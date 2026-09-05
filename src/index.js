import { tool } from "@opencode-ai/plugin";

import {
  createAgents,
  DEVELOPER_AGENT,
  mergeAgent,
  STATE_TOOL_ACCESS,
  STATE_TOOLS,
  STEERING_TOOL_ACCESS,
  STEERING_TOOLS,
} from "./agents.js";
import { createResponseTool } from "./response.js";
import { createStateService } from "./state.js";

const SESSION_MODES = new Map();

function modeForAgent(agent) {
  if (agent === DEVELOPER_AGENT) return "developer";
  if (agent === "shepherd") return "shepherd";
  if (agent === "shepherd-governor") return "governor";
  if (agent === "sheepdog") return "sheepdog";
  if (agent === "grazer") return "grazer";
  if (agent === "sheep") return "sheep";
  if (agent === "shearer-low" || agent === "shearer-medium") return "shearer";
  return "none";
}

function stateError(code, message, retryable = false) {
  return { ok: false, error: { code, message, retryable } };
}

// Exposes the constrained orchestration state API (src/state.js) as plugin
// tools. Enforcement mirrors STATE_TOOL_ACCESS in src/agents.js: the planning
// shepherd writes and reads plan artifacts; shepherd-governor and sheepdog
// read the authoritative plan; sheepdog writes and reads execution artifacts.
// Artifacts are durable Markdown files under the canonical
// `<git-common-dir>/flocky` state root in the repository's shared Git common
// directory, so linked worktrees share state while separate clones never do.
// Legacy `<git-common-dir>/herdr` artifacts are reconciled into the canonical
// root before every plan or execution operation — copied, accepted, or failed
// closed on conflict — and the legacy root is never auto-deleted. The state
// service invokes only read-only `git rev-parse`; it never writes arbitrary
// Git metadata.
export function createStateTools(stateOptions = {}) {
  const state = createStateService(stateOptions);

  const definitions = [
    {
      name: STATE_TOOLS.planWrite,
      description:
        "Durably store a plan Markdown artifact under the repository's shared Git common directory, keyed by plan ID. Planning shepherd only.",
      write: true,
      run: (args) => state.writePlan(args),
    },
    {
      name: STATE_TOOLS.planRead,
      description:
        "Read a stored plan Markdown artifact by plan ID. Shepherd, shepherd-governor, and sheepdog only.",
      write: false,
      run: (args) => state.readPlan(args.planId),
    },
    {
      name: STATE_TOOLS.executionWrite,
      description:
        "Durably store an execution Markdown artifact for a plan under the repository's shared Git common directory, keyed by plan ID. Sheepdog only.",
      write: true,
      run: (args) => state.writeExecution(args),
    },
    {
      name: STATE_TOOLS.executionRead,
      description:
        "Read a stored execution Markdown artifact by plan ID. Sheepdog only.",
      write: false,
      run: (args) => state.readExecution(args.planId),
    },
  ];

  const tools = {};
  for (const definition of definitions) {
    tools[definition.name] = tool({
      description: definition.description,
      args: {
        planId: tool.schema
          .string()
          .describe("Plan ID keying the artifact; 1-64 characters of letters, digits, dot, underscore, or hyphen."),
        ...(definition.write
          ? {
              markdown: tool.schema
                .string()
                .min(1)
                .describe("Complete Markdown body to store as the artifact content."),
            }
          : {}),
      },
      async execute(args, context) {
        const allowed = STATE_TOOL_ACCESS.get(definition.name);
        if (!allowed?.has(context?.agent)) {
          return JSON.stringify(
            stateError(
              "UNAUTHORIZED_AGENT",
              `Agent ${context?.agent ?? "unknown"} may not use ${definition.name}.`,
            ),
          );
        }
        const result = await definition.run(args);
        context.metadata({
          title: result.ok ? `${definition.name}: ${args.planId}` : `${definition.name}: ${result.error.code}`,
          metadata: result.ok
            ? { planId: args.planId, path: result.artifact.path }
            : { error: result.error.code },
        });
        return JSON.stringify(result);
      },
    });
  }
  return tools;
}

// Developer steering submission (M2, Option A, trusted Developer only).
// The sole submitter is the explicit non-flock `developer` context. The
// allowlist holds only Developer; every flock role plus unknown, ambiguous,
// none, and unset are denied fail-closed with no filesystem write. Developer
// is never inferred from session mode, directory, environment text, or prompt
// content: only an exact `context.agent === "developer"` passes. The runtime
// check stays authoritative over static per-agent permission overrides.
export function createSteeringTools(stateOptions = {}) {
  const state = createStateService(stateOptions);
  const name = STEERING_TOOLS.submit;
  return {
    [name]: tool({
      description:
        "Submit bounded Developer steering for one Plan ID target. Developer context only; flock roles are denied. Provide explicit planId, or omit it only when exactly one active steering target exists.",
      args: {
        planId: tool.schema
          .string()
          .optional()
          .describe("Explicit steering target Plan ID; required unless exactly one active target exists."),
        content: tool.schema
          .string()
          .min(1)
          .describe("Bounded steering content; at most 8192 UTF-8 bytes."),
      },
      async execute(args, context) {
        const allowed = STEERING_TOOL_ACCESS.get(name);
        if (!allowed?.has(context?.agent)) {
          return JSON.stringify(
            stateError(
              "UNAUTHORIZED_AGENT",
              `Agent ${context?.agent ?? "unknown"} may not use ${name}.`,
            ),
          );
        }
        const result = await state.submitSteering(args);
        context.metadata({
          title: result.ok ? `${name}: ${result.entry.planId}#${result.entry.sequence}` : `${name}: ${result.error.code}`,
          metadata: result.ok
            ? { planId: result.entry.planId, steeringId: result.entry.id, sequence: result.entry.sequence }
            : { error: result.error.code },
        });
        return JSON.stringify(result);
      },
    }),
  };
}

export const HerdrOrchestrationPlugin = async (_input, options = {}) => ({
  tool: {
    herdr_agent_response: createResponseTool(options.response),
    ...createStateTools(options.state),
    ...createSteeringTools(options.state),
  },
  config(config) {
    config.agent ??= {};
    const agents = createAgents(options);
    for (const [name, defaults] of Object.entries(agents)) {
      config.agent[name] = mergeAgent(defaults, config.agent[name]);
    }
  },

  async "chat.message"(input) {
    if (input.sessionID) SESSION_MODES.set(input.sessionID, modeForAgent(input.agent));
  },

  async "shell.env"(input, output) {
    output.env.SHEPHERD_MODE = input.sessionID
      ? (SESSION_MODES.get(input.sessionID) ?? "none")
      : "none";
  },

  async event({ event }) {
    if (event?.type === "session.deleted") {
      const sessionID = event.properties?.info?.id ?? event.properties?.sessionID;
      if (sessionID) SESSION_MODES.delete(sessionID);
    }
  },
});

export default HerdrOrchestrationPlugin;
export {
  createAgents,
  DEVELOPER_AGENT,
  mergeAgent,
  modeForAgent,
  STATE_TOOL_ACCESS,
  STATE_TOOLS,
  STEERING_TOOL_ACCESS,
  STEERING_TOOLS,
};
