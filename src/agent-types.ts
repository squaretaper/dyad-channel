/**
 * Lightweight AgentResponse types for the plugin side.
 * Mirrors the spec types from lib/agents/types.ts in the app repo,
 * but only includes what the plugin needs to construct + post envelopes.
 */

import type { CoordinationSignal } from "./signal-parser.js";

// ============================================================================
// Core types (subset of spec SS3.1, SS3.2)
// ============================================================================

export type AgentMessageKind =
  | 'signal'
  | 'inform'
  | 'question'
  | 'finding'
  | 'negotiation'
  | 'handoff'
  | 'heartbeat';

export type AgentMessageRouting = 'sync' | 'async' | 'fire_and_forget';

export type AgentMessageBasis = 'fresh' | 'rcd_informed' | 'pattern_echo';

export interface AgentMessagePayload {
  solo_insufficient?: boolean;
  reason?: string;
  suggested_angle?: string;
  text?: string;
  data?: Record<string, unknown>;
  agent_notes?: string;
}

export interface AgentMessage {
  from: string;
  to: string;
  kind: AgentMessageKind;
  routing: AgentMessageRouting;
  payload: AgentMessagePayload;
  thread_id?: string;
  reply_to?: string;
  seq?: number;
  thread_depth: number;
  confidence?: number;
  basis?: AgentMessageBasis;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  ttl_ms?: number;
  requires_ack?: boolean;
  display?: string;
  source_chat_id?: string;
}

export interface AgentResponseMeta {
  agent_id: string;
  model?: string;
  adapter?: string;
  latency_ms?: number;
  timestamp: string;
}

export interface AgentResponse {
  content: string;
  messages: AgentMessage[];
  meta: AgentResponseMeta;
}

// ============================================================================
// Builder: construct AgentResponse from parsed signal + raw text
// ============================================================================

/**
 * Build an AgentResponse envelope from the legacy coordination signal
 * and cleaned public text. This is the bridge between the old regex-based
 * parsing and the new structured format.
 */
export function buildAgentResponse(
  cleanText: string,
  signal: CoordinationSignal | null,
  agentName: string,
  chatId: string,
  startTime?: number,
): AgentResponse {
  const messages: AgentMessage[] = [];

  if (signal) {
    messages.push({
      from: agentName,
      to: '*',
      kind: 'signal',
      routing: 'sync',
      payload: {
        solo_insufficient: signal.solo_insufficient,
        reason: signal.reason,
        suggested_angle: signal.suggested_angle,
      },
      thread_depth: signal.chain_depth,
      confidence: signal.confidence,
      basis: signal.basis,
      priority: 'normal',
      display: signal.display || `${agentName}: solo_insufficient=${signal.solo_insufficient} (${signal.confidence})`,
      source_chat_id: chatId,
    });
  }

  return {
    content: cleanText,
    messages,
    meta: {
      agent_id: agentName,
      adapter: 'openclaw',
      timestamp: new Date().toISOString(),
      latency_ms: startTime ? Date.now() - startTime : undefined,
    },
  };
}
