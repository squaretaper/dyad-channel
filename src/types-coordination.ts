/**
 * Coordination protocol types for the Dyad channel plugin.
 * Mirrors the subset of lib/coordination/types.ts needed by the plugin.
 */

export const COORDINATION_PROTOCOL_VERSION = "dyad-coord-v1";
export const MAX_COORDINATION_DEPTH = 6;

// --- History / persistent pipeline tuning ---
export const COORD_HISTORY_MAX_ROUNDS = 5;
export const COORD_HISTORY_MAX_CHARS = 8000;
export const RECENT_RESPONSES_MAX_PER_AGENT = 2;
export const RECENT_RESPONSES_MAX_CHARS = 4000;
export const RESPONSE_SUMMARY_MAX_CHARS = 500;

export interface Proposal {
  angle: string;
  covers: string[];
  defers: string[];
  solo_sufficient?: boolean;
}

export interface ParsedCoordinationMessage {
  id: string;
  speaker: string;
  content: string; // raw JSON string
  parsed: any; // parsed JSON (or null)
  messageType: string;
}
