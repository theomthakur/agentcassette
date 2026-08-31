import { dirname, join } from "node:path";
import { createCassetteClient, type CassetteClient, type CassetteClientOptions } from "../core/client.js";
import { FileCassetteStore } from "../core/storage.js";
import type { CassetteMode } from "../core/types.js";
import { appendUsageEvent } from "./usage.js";

export type TestCassetteOptions<Request, Response> = CassetteClientOptions<Request, Response> & {
  directory?: string;
  usageFile?: string;
  testFile?: string;
};

export async function withTestCassette<Request, Response>(
  runner: "vitest" | "jest",
  options: TestCassetteOptions<Request, Response>,
): Promise<CassetteClient<Request, Response>> {
  const directory = options.directory ?? process.env.AGENTCASSETTE_DIR ?? ".agentcassette/cassettes";
  const usageFile = options.usageFile
    ?? process.env.AGENTCASSETTE_USAGE_FILE
    ?? join(dirname(directory), "usage.ndjson");
  const testFile = options.testFile;
  const mode = environmentMode() ?? options.mode ?? "auto";
  const metadata = {
    ...options.metadata,
    ...(testFile === undefined ? {} : { testFile }),
  };
  const userOnReplay = options.onReplay;
  const wrapped = await createCassetteClient({
    ...options,
    mode,
    metadata,
    store: options.store ?? new FileCassetteStore(directory),
    onReplay: async (context) => {
      await appendUsageEvent({
        type: "replay",
        cassette: context.cassette,
        turn: context.turn,
        timestamp: new Date().toISOString(),
        ...(context.response.usage?.costUsd === undefined ? {} : { costSavedUsd: context.response.usage.costUsd }),
      }, usageFile);
      await userOnReplay?.(context);
    },
  });
  await appendUsageEvent({
    type: "use",
    cassette: options.name,
    runner,
    timestamp: new Date().toISOString(),
    ...(testFile === undefined ? {} : { testFile }),
  }, usageFile);
  return wrapped;
}

function environmentMode(): CassetteMode | undefined {
  const value = process.env.AGENTCASSETTE_MODE;
  if (value === undefined || value === "") return undefined;
  if (value === "record" || value === "replay" || value === "auto") return value;
  throw new Error(`Invalid AGENTCASSETTE_MODE "${value}". Expected record, replay, or auto.`);
}
