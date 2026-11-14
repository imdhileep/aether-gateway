import type { Usage } from "../types.js";

// Approximate public list prices in USD per 1,000,000 tokens [input, output].
// Matched by longest model-name prefix so "claude-3-5-sonnet-latest" resolves.
const PRICES: Record<string, [number, number]> = {
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o": [2.5, 10],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1": [2, 8],
  "gpt-4-turbo": [10, 30],
  "o1-mini": [1.1, 4.4],
  "o1": [15, 60],
  "o3-mini": [1.1, 4.4],
  // Current Claude models (Anthropic first-party list prices, Nov 2026).
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
  "claude-3-5-haiku": [0.8, 4],
  "claude-3-5-sonnet": [3, 15],
  "claude-3-7-sonnet": [3, 15],
  "claude-3-opus": [15, 75],
  "claude-3-haiku": [0.25, 1.25],
  "gemini-1.5-flash": [0.075, 0.3],
  "gemini-1.5-pro": [1.25, 5],
  "gemini-2.0-flash": [0.1, 0.4],
  mock: [0, 0],
};

function priceFor(model: string): [number, number] {
  let best: [number, number] | null = null;
  let bestLen = -1;
  const m = model.toLowerCase();
  for (const [key, price] of Object.entries(PRICES)) {
    if (m.startsWith(key) && key.length > bestLen) {
      best = price;
      bestLen = key.length;
    }
  }
  return best ?? [0, 0];
}

/** Cost in USD for a single completion, given the upstream model and usage. */
export function costFor(model: string, usage: Usage): number {
  const [inPrice, outPrice] = priceFor(model);
  const cost = (usage.prompt_tokens / 1_000_000) * inPrice + (usage.completion_tokens / 1_000_000) * outPrice;
  // Round to 6 decimal places (micro-dollars).
  return Math.round(cost * 1e6) / 1e6;
}

export function knownModels(): string[] {
  return Object.keys(PRICES);
}
