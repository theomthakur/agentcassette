import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type UsageEvent =
  | { type: "use"; cassette: string; runner: "vitest" | "jest"; timestamp: string; testFile?: string }
  | { type: "replay"; cassette: string; turn: number; timestamp: string; costSavedUsd?: number };

export const defaultUsageFile = ".agentcassette/usage.ndjson";

export async function appendUsageEvent(event: UsageEvent, file = defaultUsageFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}
