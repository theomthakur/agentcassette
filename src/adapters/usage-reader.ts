import { readFile } from "node:fs/promises";
import type { UsageEvent } from "./usage.js";

export async function readUsageEvents(file: string): Promise<UsageEvent[]> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
  return source.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return isUsageEvent(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function isUsageEvent(value: unknown): value is UsageEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (event.type === "use" || event.type === "replay")
    && typeof event.cassette === "string"
    && typeof event.timestamp === "string";
}
