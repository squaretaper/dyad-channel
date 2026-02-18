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

// --- v3.5 filter thresholds ---
/** Confidence gap above this → SOLO (clear winner) */
export const CONFIDENCE_GAP_THRESHOLD = 0.3;
/** Angle overlap below this → PARALLEL eligible (different angles) */
export const ANGLE_OVERLAP_THRESHOLD = 0.5;
/** Both agents need at least this confidence for PARALLEL/SYNTHESIS */
export const HIGH_CONFIDENCE_THRESHOLD = 0.5;
/** Below this → neither has strong conviction → SOLO fallback */
export const LOW_CONFIDENCE_THRESHOLD = 0.3;
/** Both agents need at least this confidence for SYNTHESIS */
export const SYNTHESIS_CONFIDENCE_THRESHOLD = 0.7;

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
  builds_on_other?: boolean;  // v3.5: opt-in signal for synthesis mode
}

// --- v2 State Register ---

export interface RegisterState {
  topic: string;
  lastResponder: string;
  recentAngles: Array<{ agent: string; angle: string; roundId: string }>;
  updatedAt: string;
}

// --- v2 Dispatch ---

export type DispatchMode = "solo" | "parallel" | "synthesis";

export interface FilterResult {
  mode: DispatchMode;
  winner: string;           // primary responder (all modes)
  runnerUp?: string;        // v3.5: second responder (parallel/synthesis)
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
