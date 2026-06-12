/**
 * Client mirror of the edge functions' LLM token-usage record.
 *
 * The errand system's two LLM calls — `parse-errand` (Gemini orchestrator) and
 * `find-places` (gpt-4o-mini venue re-rank) — now return their own token spend
 * on the wire. This module validates that wire shape and prints a matching
 * `[token-usage]` line in dev, so the same record the server logs is also
 * visible from the app while developing (and is `null` when no model ran, e.g.
 * a cache hit or the offline local parse).
 */

/** Token spend for one LLM call, as returned by the edge functions. */
export interface LlmTokenUsage {
  /** The model the spend is attributed to ("gemini-2.5-flash-lite", "gpt-4o-mini"). */
  model: string;
  /** Input tokens (the prompt). */
  promptTokens: number;
  /** Output tokens (the answer; includes billed "thinking" tokens). */
  completionTokens: number;
  /** Provider-reported total. */
  totalTokens: number;
}

/**
 * Validate a function response's `usage` field into {@link LlmTokenUsage}.
 * Returns null when usage is absent (no model ran for this call) or malformed.
 */
export function shapeUsage(raw: unknown): LlmTokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const model = typeof u.model === 'string' && u.model.trim() ? u.model.trim() : null;
  const total = Number(u.totalTokens);
  if (!model || !Number.isFinite(total)) return null;
  const prompt = Number(u.promptTokens);
  const completion = Number(u.completionTokens);
  return {
    model,
    promptTokens: Number.isFinite(prompt) ? prompt : 0,
    completionTokens: Number.isFinite(completion) ? completion : 0,
    totalTokens: total,
  };
}

/**
 * Dev-only console line mirroring the server's `[token-usage]` format, so the
 * per-call spend is visible in the app logs too. No-op outside `__DEV__` or
 * when no model ran (`usage` is null).
 */
export function logTokenUsage(scope: string, usage: LlmTokenUsage | null): void {
  if (!__DEV__ || !usage) return;
  console.log(
    `[token-usage] ${scope} model=${usage.model} ` +
      `prompt=${usage.promptTokens} completion=${usage.completionTokens} ` +
      `total=${usage.totalTokens}`,
  );
}
