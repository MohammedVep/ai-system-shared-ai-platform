const INJECTION_PATTERNS = [
  /ignore\s+previous\s+instructions/gi,
  /reveal\s+system\s+prompt/gi,
  /developer\s+message/gi,
  /jailbreak/gi,
  /bypass\s+policy/gi
];

const PII_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  { regex: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, replacement: "[REDACTED_EMAIL]" },
  { regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[REDACTED_SSN]" },
  { regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: "[REDACTED_PHONE]" },
  { regex: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED_API_KEY]" }
];

export const containsPromptInjection = (text: string): boolean =>
  INJECTION_PATTERNS.some((pattern) => pattern.test(text));

export const neutralizePromptInjection = (text: string): string => {
  let updated = text;
  for (const pattern of INJECTION_PATTERNS) {
    updated = updated.replace(pattern, "[REDACTED_PROMPT_INJECTION]");
  }
  return updated;
};

export const redactPii = (text: string): string => {
  let updated = text;
  for (const pattern of PII_PATTERNS) {
    updated = updated.replace(pattern.regex, pattern.replacement);
  }
  return updated;
};
