import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { dyadPlugin } from "./src/channel.js";
import { setDyadRuntime } from "./src/runtime.js";
import { createCoordSendTool, createCoordHistoryTool } from "./src/tools.js";

// OpenClawPluginDefinition — typed inline to avoid import path issues with symlinked modules
const plugin: {
  id: string;
  name: string;
  description: string;
  configSchema: ReturnType<typeof emptyPluginConfigSchema>;
  register: (api: OpenClawPluginApi) => void;
} = {
  id: "dyad",
  name: "Dyad",
  description: "Dyad AI workspace channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setDyadRuntime(api.runtime);
    api.registerChannel({ plugin: dyadPlugin });
    // Register inter-agent coordination tools
    api.registerTool(createCoordSendTool());
    api.registerTool(createCoordHistoryTool());
  },
};

export default plugin;
