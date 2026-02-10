/**
 * Coordination protocol types for the Dyad channel plugin.
 * Mirrors the subset of lib/coordination/types.ts needed by the plugin.
 */

export const COORDINATION_PROTOCOL_VERSION = "dyad-coord-v1";
export const MAX_COORDINATION_DEPTH = 6;

export interface Proposal {
  angle: string;
  covers: string[];
  defers: string[];
}

export interface ParsedCoordinationMessage {
  id: string;
  speaker: string;
  content: string; // raw JSON string
  parsed: any; // parsed JSON (or null)
  messageType: string;
}
