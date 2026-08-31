import { asJsonValue, isRecord, unknownToContent } from "../core/canonical.js";
import type { ContentPart, JsonValue, TokenUsage, ToolDefinition } from "../core/types.js";

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseJson(value: unknown): JsonValue {
  if (typeof value !== "string") return asJsonValue(value);
  try {
    return asJsonValue(JSON.parse(value));
  } catch {
    return value;
  }
}

export function normalizeTools(value: unknown, style: "openai" | "anthropic" | "google"): ToolDefinition[] {
  const source = style === "google"
    ? records(value).flatMap((group) => records(group.functionDeclarations ?? group.function_declarations))
    : records(value);
  return source.flatMap((item) => {
    const fn = style === "openai" && isRecord(item.function) ? item.function : item;
    const name = stringValue(fn.name);
    if (!name) return [];
    const schema = fn.parameters ?? fn.parametersJsonSchema ?? fn.parameters_json_schema ?? fn.input_schema ?? fn.inputSchema ?? {};
    const tool: ToolDefinition = { name, inputSchema: asJsonValue(schema) };
    const description = stringValue(fn.description);
    if (description !== undefined) tool.description = description;
    return [tool];
  });
}

export function normalizeUsage(
  value: unknown,
  inputKeys: string[],
  outputKeys: string[],
  totalKeys: string[] = [],
): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = firstNumber(value, inputKeys) ?? 0;
  const outputTokens = firstNumber(value, outputKeys) ?? 0;
  const totalTokens = firstNumber(value, totalKeys) ?? inputTokens + outputTokens;
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const result = numberValue(record[key]);
    if (result !== undefined) return result;
  }
  return undefined;
}

export function contentParts(value: unknown): ContentPart[] {
  return unknownToContent(value);
}

export function contentToProviderText(content: ContentPart[]): string | null {
  if (content.length === 0) return null;
  return content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "json") return JSON.stringify(part.value);
    return `[image:${part.source}]`;
  }).join("\n");
}
