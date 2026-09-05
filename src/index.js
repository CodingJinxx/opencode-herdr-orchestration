import { tool } from "@opencode-ai/plugin";

import {
  createAgents,
  DEVELOPER_AGENT,
  mergeAgent,
  OWNERSHIP_TOOL_ACCESS,
  OWNERSHIP_TOOLS,
  RAW_STEERING_TOOL_ACCESS,
  RAW_STEERING_TOOLS,
  SHEPHERD_PHASES,
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

// Shepherd-only raw steering plus ownership lifecycle tools (M3).
// Only `shepherd` and `shepherd-governor` pass the runtime allowlist;
// sheepdog, grazer, sheep, shearers, developer, unknown, and unset are
// denied fail-closed with no filesystem write. State-level session plus
// generation fencing stays authoritative inside src/state.js (NOT
// AUTHORITATIVE PHASE for non-owners). Steering never authorizes push,
// tag, publish, deploy, merge, or any consequential action; existing
// approvals still required.
export function createRawSteeringTools(stateOptions = {}) {
  const state = createStateService(stateOptions);
  const definitions = [
    {
      name: RAW_STEERING_TOOLS.check,
      description:
        "Check unread Developer steering for one Plan ID target without loading bodies. Shepherd phases only with authoritative phase, session, and generation; non-owners receive NOT AUTHORITATIVE PHASE.",
      run: (args) => state.checkSteering(args),
    },
    {
      name: RAW_STEERING_TOOLS.read,
      description:
        "Read ordered exact unread Developer steering with no mutation. Shepherd phases only with authoritative phase, session, and generation.",
      run: (args) => state.readSteering(args),
    },
    {
      name: RAW_STEERING_TOOLS.consume,
      description:
        "Consume Developer steering only after the authoritative owner recorded sync disposition for the sync point; idempotent. Shepherd phases only. Steering never authorizes consequential actions.",
      run: (args) => state.consumeSteering(args),
    },
  ];
  const tools = {};
  for (const definition of definitions) {
    tools[definition.name] = tool({
      description: definition.description,
      args: {
        planId: tool.schema.string().describe("Explicit steering target Plan ID."),
        phase: tool.schema.string().describe("Owner phase: planning or governance."),
        session: tool.schema.string().describe("Authoritative session fencing the ownership record."),
        generation: tool.schema.number().int().min(1).describe("Authoritative generation fencing the ownership record."),
        ...(definition.name === RAW_STEERING_TOOLS.consume
          ? {
              ids: tool.schema.array(tool.schema.string()).min(1).max(1000).describe("Steering ids to consume idempotently."),
              syncPoint: tool.schema.string().describe("Closed sync point whose disposition was recorded before consume."),
              disposition: tool.schema.string().describe("Closed disposition recorded before consume."),
            }
          : {}),
      },
      async execute(args, context) {
        const allowed = RAW_STEERING_TOOL_ACCESS.get(definition.name);
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
          metadata: result.ok ? { planId: args.planId } : { error: result.error.code },
        });
        return JSON.stringify(result);
      },
    });
  }
  return tools;
}

export function createOwnershipTools(stateOptions = {}) {
  const state = createStateService(stateOptions);
  const definitions = [
    {
      name: OWNERSHIP_TOOLS.claim,
      description:
        "Claim or hand off validated target lifecycle ownership for one Plan ID with session plus generation fencing. Shepherd phases only; generations must increase and both phases cannot race on the same generation.",
      run: (args) => state.claimOwnership(args),
    },
    {
      name: OWNERSHIP_TOOLS.read,
      description: "Read the validated lifecycle record for one Plan ID. Shepherd phases only; non-owners receive NOT AUTHORITATIVE PHASE.",
      run: (args) => state.readOwnership(args),
    },
    {
      name: OWNERSHIP_TOOLS.sync,
      description:
        "Record semantic synchronization disposition for one closed sync point (planning-start, pre-plan, pre-assignment, milestone-executing, result-received, continue, finalize, consequential-preparation). Shepherd phases only; disposition is recorded before consume and consume is idempotent.",
      run: (args) => state.recordSync(args),
    },
    {
      name: OWNERSHIP_TOOLS.snapshot,
      description:
        "Record a bounded lifecycle snapshot for one stage (planning, executing, result-evaluation, consequential-preparation). Shepherd phases only; pending consequential action must be recorded before the consequential-preparation snapshot and check.",
      run: (args) => state.recordSnapshot(args),
    },
    {
      name: OWNERSHIP_TOOLS.correct,
      description:
        "Route semantic correction to sheepdog as normal corrective instructions, never raw records. Shepherd phases only; steering never authorizes consequential actions.",
      run: (args) => state.routeCorrection(args),
    },
  ];
  const tools = {};
  for (const definition of definitions) {
    const isClaim = definition.name === OWNERSHIP_TOOLS.claim;
    const isSync = definition.name === OWNERSHIP_TOOLS.sync;
    const isSnapshot = definition.name === OWNERSHIP_TOOLS.snapshot;
    const isCorrect = definition.name === OWNERSHIP_TOOLS.correct;
    tools[definition.name] = tool({
      description: definition.description,
      args: {
        planId: tool.schema.string().describe("Lifecycle target Plan ID."),
        phase: tool.schema.string().describe("Owner phase: planning or governance."),
        session: tool.schema.string().describe("Authoritative session fencing the ownership record."),
        ...(isClaim || isSync || isSnapshot || isCorrect
          ? { generation: tool.schema.number().int().min(1).describe("Authoritative generation fencing the ownership record.") }
          : {}),
        ...(isClaim
          ? {
              milestone: tool.schema.string().min(1).describe("Bounded milestone summary."),
              lifecycleState: tool.schema.string().describe("Closed lifecycle state."),
              currentObjective: tool.schema.string().optional().describe("Bounded current objective semantic summary."),
              currentAction: tool.schema.string().optional().describe("Bounded current action semantic summary."),
              activeSheepdogTarget: tool.schema.string().optional().describe("Active sheepdog target or empty when yielded."),
              relevantRevision: tool.schema.string().optional().describe("Relevant revision summary."),
              pendingConsequentialAction: tool.schema.string().optional().describe("Pending consequential action summary."),
            }
          : {}),
        ...(isSync
          ? {
              syncPoint: tool.schema.string().describe("Closed sync point."),
              disposition: tool.schema.string().describe("Closed disposition recorded before consume."),
              note: tool.schema.string().optional().describe("Bounded semantic note."),
            }
          : {}),
        ...(isSnapshot
          ? {
              stage: tool.schema.string().describe("Snapshot stage."),
              milestone: tool.schema.string().optional().describe("Bounded milestone override."),
              lifecycleState: tool.schema.string().optional().describe("Closed lifecycle state override."),
              currentObjective: tool.schema.string().optional().describe("Bounded current objective override."),
              currentAction: tool.schema.string().optional().describe("Bounded current action override."),
              activeSheepdogTarget: tool.schema.string().optional().describe("Active sheepdog target override."),
              relevantRevision: tool.schema.string().optional().describe("Relevant revision override."),
              pendingConsequentialAction: tool.schema.string().optional().describe("Pending consequential action override."),
            }
          : {}),
        ...(isCorrect
          ? {
              correction: tool.schema.string().min(1).describe("Normal semantic corrective instructions for sheepdog, never raw records."),
              syncPoint: tool.schema.string().optional().describe("Related closed sync point."),
            }
          : {}),
      },
      async execute(args, context) {
        const allowed = OWNERSHIP_TOOL_ACCESS.get(definition.name);
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
          metadata: result.ok ? { planId: args.planId } : { error: result.error.code },
        });
        return JSON.stringify(result);
      },
    });
  }
  return tools;
}

export const HerdrOrchestrationPlugin = async (_input, options = {}) => ({
  tool: {
    herdr_agent_response: createResponseTool(options.response),
    ...createStateTools(options.state),
    ...createSteeringTools(options.state),
    ...createRawSteeringTools(options.state),
    ...createOwnershipTools(options.state),
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
  OWNERSHIP_TOOL_ACCESS,
  OWNERSHIP_TOOLS,
  RAW_STEERING_TOOL_ACCESS,
  RAW_STEERING_TOOLS,
  SHEPHERD_PHASES,
  STATE_TOOL_ACCESS,
  STATE_TOOLS,
  STEERING_TOOL_ACCESS,
  STEERING_TOOLS,
};
