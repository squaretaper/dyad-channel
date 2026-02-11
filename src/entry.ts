import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { setDyadRuntime } from "./runtime.js";
import { dyadPlugin } from "./channel.js";

export default function register(api: OpenClawPluginApi) {
  // Capture the PluginRuntime for use in startAccount's dispatch calls
  setDyadRuntime(api.runtime);

  // Register the Dyad channel plugin
  api.registerChannel({ plugin: dyadPlugin });
}
