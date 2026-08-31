import { asJsonValue, isRecord } from "./canonical.js";
import type { JsonValue } from "./types.js";

export interface RedactionContext {
  path: string;
  key?: string;
  value: JsonValue;
}

export interface RedactionRule {
  name: string;
  match(context: RedactionContext): boolean;
  replacement?: JsonValue;
}

export interface RedactionOptions {
  rules?: RedactionRule[];
  includeDefaults?: boolean;
}

const SECRET_KEY = /(?:api[-_]?key|authorization|password|passwd|secret|access[-_]?token|refresh[-_]?token|cookie)/iu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE_CANDIDATE = /(?<!\d)(?:\+?\d[\d ().-]{7,}\d)(?!\d)/gu;

export const defaultRedactionRules: RedactionRule[] = [
  {
    name: "secret-key",
    match: ({ key }) => key !== undefined && SECRET_KEY.test(key),
  },
];

export function redact<T>(value: T, options: RedactionOptions = {}): T {
  const rules = [
    ...(options.includeDefaults === false ? [] : defaultRedactionRules),
    ...(options.rules ?? []),
  ];
  return visit(value, "$", undefined, rules, options.includeDefaults !== false) as T;
}

function visit(
  value: unknown,
  path: string,
  key: string | undefined,
  rules: RedactionRule[],
  redactDefaultStrings: boolean,
): unknown {
  const json = asJsonValue(value);
  const context: RedactionContext = key === undefined ? { path, value: json } : { path, key, value: json };
  const rule = rules.find((candidate) => {
    try {
      return candidate.match(context);
    } catch {
      return false;
    }
  });
  if (rule) return rule.replacement ?? "[REDACTED]";

  if (typeof value === "string" && redactDefaultStrings) {
    return value
      .replace(BEARER_TOKEN, "Bearer [REDACTED]")
      .replace(EMAIL, "[REDACTED_EMAIL]")
      .replace(PHONE_CANDIDATE, (candidate) => countDigits(candidate) >= 10 ? "[REDACTED_PHONE]" : candidate);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => visit(item, `${path}[${index}]`, undefined, rules, redactDefaultStrings));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [childKey, item] of Object.entries(value)) {
      result[childKey] = visit(item, `${path}.${childKey}`, childKey, rules, redactDefaultStrings);
    }
    return result;
  }
  return value;
}

function countDigits(value: string): number {
  return value.replace(/\D/gu, "").length;
}
