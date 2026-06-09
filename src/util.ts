import { randomBytes } from "node:crypto";

export function genId(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Whether an upstream failure should trigger key rotation / failover.
 * Network errors (status 0), timeouts, rate limits and 5xx are transient.
 * 4xx client errors (bad request, auth) are surfaced so they get fixed.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Cheap token estimate (~4 chars/token) used only when a provider omits usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Concatenate message contents into a single string for embedding/estimation. */
export function flattenMessages(messages: { role: string; content: string | null }[]): string {
  return messages.map((m) => `${m.role}: ${m.content ?? ""}`).join("\n");
}

/**
 * Parse a fetch SSE body into successive `data:` payload strings.
 * Handles multi-line events and arbitrary chunk boundaries.
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      // SSE events are separated by a blank line.
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = rawEvent
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        if (dataLines.length) yield dataLines.join("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
