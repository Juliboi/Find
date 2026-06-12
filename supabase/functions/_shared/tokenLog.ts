// Shared LLM token-usage logger for the edge functions (Deno runtime).
//
// Answers "how much are we spending on tokens?" straight from the function logs
// (`supabase functions logs <fn>`). Every LLM call in the errand system prints
// ONE greppable `[token-usage]` line so spend can be tallied with a simple
// `grep '\[token-usage\]'` over the logs.
//
// Both providers we use report usage, just under different field names — Gemini
// as `usageMetadata` (…TokenCount), OpenAI as `usage` (…_tokens) — so we
// normalize them into one shape and print a consistent record, including an
// APPROX USD cost from published per-1M-token rates. The cost is a rough read
// for sizing spend, NOT a billing figure (it ignores caching, batch discounts,
// and any rate change since the table below was written).
//
// deno-lint-ignore-file no-explicit-any

export interface TokenUsage {
  /** Input tokens (the prompt we sent). */
  promptTokens: number;
  /** Output tokens (the model's answer; includes "thinking" tokens if billed). */
  completionTokens: number;
  /** Provider-reported total (falls back to prompt + completion). */
  totalTokens: number;
}

// Published list prices in USD per 1,000,000 tokens, as of 2026-06. Update these
// if a model tier or vendor pricing changes — they only drive the rough `~usd`
// figure in the logs, never any app behaviour.
const PRICING_PER_M: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

/** Normalize Gemini's `usageMetadata` into the shared shape. Never throws. */
export function geminiUsage(usageMetadata: any): TokenUsage {
  const prompt = Number(usageMetadata?.promptTokenCount) || 0;
  // Flash tiers can bill "thinking" tokens (`thoughtsTokenCount`) separately
  // from the visible answer (`candidatesTokenCount`); both are output we pay for.
  const completion =
    (Number(usageMetadata?.candidatesTokenCount) || 0) +
    (Number(usageMetadata?.thoughtsTokenCount) || 0);
  const total = Number(usageMetadata?.totalTokenCount) || prompt + completion;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

/** Normalize OpenAI's chat-completion `usage` into the shared shape. Never throws. */
export function openaiUsage(usage: any): TokenUsage {
  const prompt = Number(usage?.prompt_tokens) || 0;
  const completion = Number(usage?.completion_tokens) || 0;
  const total = Number(usage?.total_tokens) || prompt + completion;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

/** Rough USD cost from the table above; null when the model isn't priced here. */
function approxCostUsd(model: string, usage: TokenUsage): number | null {
  const price = PRICING_PER_M[model];
  if (!price) return null;
  return (
    (usage.promptTokens / 1_000_000) * price.input +
    (usage.completionTokens / 1_000_000) * price.output
  );
}

/**
 * Print one `[token-usage]` line for a single LLM call. `fn` is the edge
 * function and `step` the logical step inside it (so the discover flow's two
 * calls — parse-errand "orchestrate" and find-places "rerank" — stay separable
 * in the logs). Logging must never break a request, so this swallows errors.
 */
export function logTokenUsage(args: {
  fn: string;
  step: string;
  model: string;
  usage: TokenUsage;
}): void {
  try {
    const { fn, step, model, usage } = args;
    const cost = approxCostUsd(model, usage);
    console.log(
      `[token-usage] fn=${fn} step=${step} model=${model} ` +
        `prompt=${usage.promptTokens} completion=${usage.completionTokens} ` +
        `total=${usage.totalTokens}` +
        (cost != null ? ` ~usd=${cost.toFixed(6)}` : ' ~usd=? (unpriced model)'),
    );
  } catch {
    // A logging failure must never take down the actual request.
  }
}
