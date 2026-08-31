import { stableStringify } from "./canonical.js";
import type { JsonValue, SemanticRequest } from "./types.js";

export type DiffKind = "added" | "removed" | "changed" | "type-changed";

export interface DiffEntry {
  path: string;
  kind: DiffKind;
  expected?: JsonValue;
  actual?: JsonValue;
}

export function structuredDiff(expected: unknown, actual: unknown): DiffEntry[] {
  const entries: DiffEntry[] = [];
  walk(expected, actual, "$", entries);
  return entries;
}

function walk(expected: unknown, actual: unknown, path: string, entries: DiffEntry[]): void {
  if (Object.is(expected, actual)) return;
  if (expected === undefined) {
    entries.push({ path, kind: "added", actual: toDiffValue(actual) });
    return;
  }
  if (actual === undefined) {
    entries.push({ path, kind: "removed", expected: toDiffValue(expected) });
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      walk(expected[index], actual[index], `${path}[${index}]`, entries);
    }
    return;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) walk(expected[key], actual[key], `${path}.${key}`, entries);
    return;
  }
  const kind: DiffKind = typeof expected === typeof actual ? "changed" : "type-changed";
  entries.push({ path, kind, expected: toDiffValue(expected), actual: toDiffValue(actual) });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toDiffValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(toDiffValue);
  if (isPlainObject(value)) {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = toDiffValue(item);
    }
    return result;
  }
  return String(value);
}

export interface DivergenceReport {
  cassette: string;
  turn: number;
  expectedFingerprint: string;
  actualFingerprint: string;
  expected: SemanticRequest;
  actual: SemanticRequest;
  diff: DiffEntry[];
}

export class CassetteDivergenceError extends Error {
  readonly report: DivergenceReport;

  constructor(report: DivergenceReport) {
    super(formatDivergence(report));
    this.name = "CassetteDivergenceError";
    this.report = report;
  }
}

function formatDivergence(report: DivergenceReport): string {
  const lines = [
    `Agent cassette diverged at turn ${report.turn + 1} in "${report.cassette}".`,
    `Expected fingerprint: ${report.expectedFingerprint}`,
    `Actual fingerprint:   ${report.actualFingerprint}`,
    "",
    "Structured request diff:",
  ];
  if (report.diff.length === 0) {
    lines.push("  Requests differ under the configured fingerprint, but their stored structures are equal.");
  } else {
    for (const item of report.diff.slice(0, 30)) {
      const expected = item.expected === undefined ? "<missing>" : stableStringify(item.expected);
      const actual = item.actual === undefined ? "<missing>" : stableStringify(item.actual);
      lines.push(`  ${item.path} (${item.kind})`, `    expected: ${expected}`, `    actual:   ${actual}`);
    }
    if (report.diff.length > 30) lines.push(`  …and ${report.diff.length - 30} more differences.`);
  }
  lines.push("", "Fix the changed request, re-record this cassette intentionally, or provide a custom fingerprint when the change is non-behavioral.");
  return lines.join("\n");
}
