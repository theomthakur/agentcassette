import type { ContentPart, JsonValue, MessageRole, SemanticMessage } from "./types.js";

const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})\b/giu;
const UNIX_TIMESTAMP = /\b1[5-9]\d{8}(?:\d{3})?\b/gu;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (isRecord(value)) {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = asJsonValue(item);
    }
    return result;
  }
  return String(value);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(asJsonValue(value)));
}

function sortValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    const result: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) result[key] = sortValue(item as JsonValue);
    }
    return result;
  }
  return value;
}

export function normalizeSemanticText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(ISO_TIMESTAMP, "<timestamp>")
    .replace(UNIX_TIMESTAMP, "<timestamp>")
    .replace(/\s+/gu, " ")
    .trim();
}

export function textPart(text: string): ContentPart {
  return { type: "text", text };
}

export function normalizeRole(value: unknown): MessageRole {
  if (value === "system" || value === "assistant" || value === "tool") return value;
  if (value === "model") return "assistant";
  if (value === "function") return "tool";
  return "user";
}

export function contentToText(content: ContentPart[]): string {
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "json") return stableStringify(part.value);
      return `[image:${part.source}]`;
    })
    .join("\n");
}

export function unknownToContent(value: unknown): ContentPart[] {
  if (typeof value === "string") return [textPart(value)];
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((part) => {
      if (typeof part === "string") return [textPart(part)];
      if (!isRecord(part)) return [{ type: "json", value: asJsonValue(part) } satisfies ContentPart];
      if (typeof part.text === "string") return [textPart(part.text)];
      if (part.type === "text" && typeof part.text === "string") return [textPart(part.text)];
      if (part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
        return [{ type: "image", source: part.image_url.url } satisfies ContentPart];
      }
      return [{ type: "json", value: asJsonValue(part) } satisfies ContentPart];
    });
  }
  return [{ type: "json", value: asJsonValue(value) }];
}

export function messageFromUnknown(value: unknown): SemanticMessage {
  if (!isRecord(value)) return { role: "user", content: unknownToContent(value) };
  const message: SemanticMessage = {
    role: normalizeRole(value.role),
    content: unknownToContent(value.content),
  };
  if (typeof value.name === "string") message.name = value.name;
  if (typeof value.tool_call_id === "string") message.toolCallId = value.tool_call_id;
  if (typeof value.toolCallId === "string") message.toolCallId = value.toolCallId;
  return message;
}
