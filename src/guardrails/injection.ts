// Heuristic prompt-injection / jailbreak detection. Pattern hits accumulate a
// score; callers decide whether to flag or block based on configured mode.

export interface InjectionResult {
  detected: boolean;
  score: number;
  patterns: string[];
}

interface Rule {
  name: string;
  regex: RegExp;
  weight: number;
}

const RULES: Rule[] = [
  { name: "ignore_previous", regex: /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\b.*\b(?:instructions?|prompts?|messages?|context)\b/is, weight: 2 },
  { name: "disregard", regex: /\bdisregard\b.*\b(?:instructions?|prompt|context|rules?)\b/is, weight: 2 },
  { name: "forget", regex: /\bforget\s+(?:everything|all|your|the)\b.*\b(?:instructions?|rules?|context)\b/is, weight: 2 },
  { name: "reveal_prompt", regex: /\b(?:reveal|show|print|repeat|output|tell\s+me)\b.*\b(?:system\s+prompt|your\s+(?:instructions?|prompt|rules?))\b/is, weight: 2 },
  { name: "system_prompt_ref", regex: /\bsystem\s+prompt\b/i, weight: 1 },
  { name: "dan_mode", regex: /\b(?:DAN|do\s+anything\s+now|developer\s+mode|jailbreak)\b/i, weight: 2 },
  { name: "unrestricted_persona", regex: /\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:unrestricted|uncensored|unfiltered|amoral)\b/i, weight: 2 },
  { name: "override_rules", regex: /\boverride\b.*\b(?:rules?|instructions?|guardrails?|safety|restrictions?)\b/is, weight: 2 },
  { name: "pretend", regex: /\bpretend\s+(?:to\s+be|you\s+are|that)\b/i, weight: 1 },
  { name: "bypass", regex: /\bbypass\b.*\b(?:filter|safety|guardrails?|restrictions?)\b/is, weight: 2 },
];

const SCORE_THRESHOLD = 2;

export function scanInjection(text: string): InjectionResult {
  let score = 0;
  const patterns: string[] = [];
  for (const rule of RULES) {
    if (rule.regex.test(text)) {
      score += rule.weight;
      patterns.push(rule.name);
    }
  }
  return { detected: score >= SCORE_THRESHOLD, score, patterns };
}
