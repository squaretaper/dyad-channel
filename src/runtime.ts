import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setDyadRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getDyadRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Dyad runtime not initialized");
  }
  return runtime;
}
