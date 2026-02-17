/**
 * Coordination protocol types for the Dyad channel plugin.
 * Mirrors the subset of lib/coordination/types.ts needed by the plugin.
 *
 * v2: Haiku micro-proposals + deterministic SOLO filter (replaces Opus negotiate pipeline)
 */

export const COORDINATION_PROTOCOL_VERSION = "dyad-coord-v2";
export const MAX_COORDINATION_DEPTH = 6;

// --- History / persistent pipeline tuning ---
export const COORD_HISTORY_MAX_ROUNDS = 5;
export const COORD_HISTORY_MAX_CHARS = 8000;
export const RECENT_RESPONSES_MAX_PER_AGENT = 2;
export const RECENT_RESPONSES_MAX_CHARS = 4000;
export const RESPONSE_SUMMARY_MAX_CHARS = 500;

// --- v2 filter thresholds ---
/** Confidence difference below this is treated as a tie → lexicographic tiebreaker */
export const CONFIDENCE_EPSILON = 0.01;

// --- v1 Proposal (kept for Layer 2 / history parsing) ---

export interface Proposal {
  angle: string;
  covers: string[];
  defers: string[];
  solo_sufficient?: boolean;
}

// --- v2 Micro-Proposal ---

export interface MicroProposal {
  angle: string;
  confidence: number;      // 0-1
  covers: string[];
  solo_sufficient: boolean;
}

// --- v2 State Register ---

export interface RegisterState {
  topic: string;
  lastResponder: string;
  recentAngles: Array<{ agent: string; angle: string; roundId: string }>;
  updatedAt: string;
}

// --- v2 Dispatch ---

/** "sequential" will be added in v3.5 for synthesis */
export type DispatchMode = "solo";

export interface FilterResult {
  mode: DispatchMode;
  winner: string;           // botName of the winner
  reason: string;           // human-readable for logging
  proposals: Record<string, MicroProposal>;
}

// --- Shared ---

export interface ParsedCoordinationMessage {
  id: string;
  speaker: string;
  content: string; // raw JSON string
  parsed: any; // parsed JSON (or null)
  messageType: string;
}
