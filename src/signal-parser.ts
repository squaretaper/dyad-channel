/**
 * Coordination signal parser — dual-format support.
 *
 * Parses [COORDINATION]...[/COORDINATION] text blocks and
 * <!-- coordination: {...} --> HTML comments from agent responses.
 * Strips the signal from the public-facing text.
 *
 * Per v5 spec §6.3: always-emit requirement. A missing block is
 * an emission error, not an implicit false.
 */

export interface CoordinationSignal {
  solo_insufficient: boolean;
  confidence: number;
  reason: string;
  suggested_angle?: string;
  basis: "fresh" | "rcd_informed" | "pattern_echo";
  chain_depth: number;
  display?: string;
}

export function parseCoordinationSignal(text: string): {
  signal: CoordinationSignal | null;
  cleanText: string;
} {
  // Format A: [COORDINATION]...[/COORDINATION]
  const blockMatch = text.match(
    /\[COORDINATION\]\s*([\s\S]*?)\s*\[\/COORDINATION\]/i,
  );
  if (blockMatch) {
    const signal = parseTextBlock(blockMatch[1]);
    const cleanText = text.replace(blockMatch[0], "").trim();
    return { signal, cleanText };
  }

  // Format B: <!-- coordination: {...} -->
  const commentMatch = text.match(
    /<!--\s*coordination:\s*(\{[\s\S]*?\})\s*-->/i,
  );
  if (commentMatch) {
    try {
      const raw = JSON.parse(commentMatch[1]) as Record<string, unknown>;
      const signal = normalizeSignal(raw);
      if (signal) {
        const cleanText = text.replace(commentMatch[0], "").trim();
        return { signal, cleanText };
      }
    } catch {
      /* fall through — malformed JSON */
    }
  }

  // No signal found — per spec §6.2, this is an emission error in v5.0
  return { signal: null, cleanText: text };
}

function parseTextBlock(block: string): CoordinationSignal | null {
  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const kv: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) kv[m[1]] = m[2];
  }

  if (!("solo_insufficient" in kv)) return null;

  return normalizeSignal(kv);
}

function normalizeSignal(
  kv: Record<string, unknown>,
): CoordinationSignal | null {
  if (!("solo_insufficient" in kv)) return null;

  const solo = kv.solo_insufficient;
  const soloInsufficient =
    solo === true || solo === "true" || solo === "True";

  return {
    solo_insufficient: soloInsufficient,
    confidence: parseFloat(String(kv.confidence ?? "0.5")) || 0.5,
    reason: String(kv.reason ?? ""),
    suggested_angle: kv.suggested_angle
      ? String(kv.suggested_angle)
      : undefined,
    basis: (["fresh", "rcd_informed", "pattern_echo"].includes(
      String(kv.basis ?? ""),
    )
      ? String(kv.basis)
      : "fresh") as CoordinationSignal["basis"],
    chain_depth: parseInt(String(kv.chain_depth ?? "1"), 10) || 1,
    display: kv.display ? String(kv.display) : undefined,
  };
}
