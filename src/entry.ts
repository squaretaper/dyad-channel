import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { setDyadRuntime } from "./runtime.js";
import { dyadPlugin } from "./channel.js";
import { createWorkspaceToolFactories } from "./tools.js";

export default function register(api: OpenClawPluginApi) {
  // Capture the PluginRuntime for use in startAccount's dispatch calls
  setDyadRuntime(api.runtime);

  // Register the Dyad channel plugin
  api.registerChannel({ plugin: dyadPlugin });

  // Register ALL workspace tools (dynamically discovered from Dyad MCP endpoint).
  // This includes coordination tools (send_coordination_message, get_coordination_context)
  // which are MCP tools like any other. No hardcoded business logic in the plugin.
  for (const factory of createWorkspaceToolFactories()) {
    api.registerTool(factory);
  }
}
