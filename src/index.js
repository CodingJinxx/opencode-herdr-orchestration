import { createAgents, mergeAgent } from "./agents.js";
import { createResponseTool } from "./response.js";

const SESSION_MODES = new Map();

function modeForAgent(agent) {
  if (agent === "shepherd") return "shepherd";
  if (agent === "shepherd-governor") return "governor";
  if (agent === "sheepdog") return "sheepdog";
  if (agent === "grazer") return "grazer";
  if (agent === "sheep") return "sheep";
  if (agent === "shearer-low" || agent === "shearer-medium") return "shearer";
  return "none";
}

export const HerdrOrchestrationPlugin = async (_input, options = {}) => ({
  tool: {
    herdr_agent_response: createResponseTool(options.response),
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
export { createAgents, modeForAgent };
