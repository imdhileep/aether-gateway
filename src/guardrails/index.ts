import type { ResolvedConfig } from "../config.js";
import type { ChatMessage } from "../types.js";
import { scanInjection, type InjectionResult } from "./injection.js";
import { scanPii, type PiiFinding } from "./pii.js";

export interface InputGuardResult {
  messages: ChatMessage[];
  blocked: boolean;
  blockReason?: string;
  pii: PiiFinding[];
  injection: InjectionResult;
}

export function applyInputGuardrails(messages: ChatMessage[], config: ResolvedConfig): InputGuardResult {
  const piiMode = config.guardrails.pii.mode;
  const injMode = config.guardrails.injection.mode;

  const aggregate = new Map<string, number>();
  let out = messages;
  if (piiMode !== "off") {
    out = messages.map((m) => {
      if (typeof m.content !== "string" || !m.content) return m;
      const r = scanPii(m.content);
      for (const f of r.found) aggregate.set(f.type, (aggregate.get(f.type) ?? 0) + f.count);
      return piiMode === "redact" ? { ...m, content: r.redacted } : m;
    });
  }
  const pii: PiiFinding[] = [...aggregate].map(([type, count]) => ({ type, count }));

  let injection: InjectionResult = { detected: false, score: 0, patterns: [] };
  if (injMode !== "off") {
    const userText = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content ?? "")
      .join("\n");
    injection = scanInjection(userText);
  }

  let blocked = false;
  let blockReason: string | undefined;
  if (piiMode === "block" && pii.length > 0) {
    blocked = true;
    blockReason = "Request blocked by guardrails: input contains PII";
  } else if (injMode === "block" && injection.detected) {
    blocked = true;
    blockReason = "Request blocked by guardrails: prompt injection detected";
  }

  return { messages: out, blocked, blockReason, pii, injection };
}

export interface OutputGuardResult {
  content: string;
  pii: PiiFinding[];
}

export function applyOutputGuardrails(content: string, config: ResolvedConfig): OutputGuardResult {
  const { mode, scan_output } = config.guardrails.pii;
  if (!scan_output || mode === "off") return { content, pii: [] };
  const r = scanPii(content);
  const redact = mode === "redact" || mode === "block";
  return { content: redact ? r.redacted : content, pii: r.found };
}

export type { PiiFinding } from "./pii.js";
export type { InjectionResult } from "./injection.js";
