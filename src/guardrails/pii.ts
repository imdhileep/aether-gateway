// PII detection + redaction. Ordered detectors run sequentially over the text
// so earlier (more specific) matches don't get re-matched by looser patterns.

export interface PiiFinding {
  type: string;
  count: number;
}

export interface PiiScanResult {
  redacted: string;
  found: PiiFinding[];
  hasPii: boolean;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

interface Detector {
  type: string;
  regex: RegExp;
  /** Optional validator; matches that fail are left untouched. */
  validate?: (match: string) => boolean;
}

const DETECTORS: Detector[] = [
  { type: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: "aws_key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    type: "credit_card",
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    validate: (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    },
  },
  { type: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: "phone", regex: /(?<!\d)(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}(?!\d)/g },
  { type: "ipv4", regex: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];

export function scanPii(text: string): PiiScanResult {
  let working = text;
  const found: PiiFinding[] = [];

  for (const d of DETECTORS) {
    let count = 0;
    working = working.replace(d.regex, (match) => {
      if (d.validate && !d.validate(match)) return match;
      count++;
      return `[REDACTED_${d.type.toUpperCase()}]`;
    });
    if (count > 0) found.push({ type: d.type, count });
  }

  return { redacted: working, found, hasPii: found.length > 0 };
}
