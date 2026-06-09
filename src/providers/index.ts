import { anthropicProvider } from "./anthropic.js";
import type { Provider } from "./base.js";
import { geminiProvider } from "./gemini.js";
import { mockProvider } from "./mock.js";
import { openaiProvider } from "./openai.js";

const registry: Record<string, Provider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  mock: mockProvider,
};

export function getProvider(name: string): Provider {
  const p = registry[name];
  if (!p) throw new Error(`Unknown provider: ${name}`);
  return p;
}

export function hasProvider(name: string): boolean {
  return name in registry;
}

export type { Provider } from "./base.js";
