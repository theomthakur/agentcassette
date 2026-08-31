import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendUsageEvent } from "../src/adapters/usage.js";
import { runCli } from "../src/cli/program.js";
import { FileCassetteStore, createCassetteClient, semantic, type SemanticRequest, type SemanticResponse } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const input: SemanticRequest = { messages: [{ role: "user", content: [{ type: "text", text: "cli" }] }], tools: [] };
const output: SemanticResponse = {
  content: [{ type: "text", text: "ok" }],
  toolCalls: [],
  usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, costUsd: 0.01 },
};

async function record(directory: string, name: string): Promise<void> {
  const client = await createCassetteClient({
    name,
    mode: "record",
    store: new FileCassetteStore(directory),
    adapter: semantic(),
    client: async () => output,
  });
  await client(input);
}

describe("CLI", () => {
  it("lists, verifies, and reports stats for valid cassettes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentcassette-cli-"));
    directories.push(root);
    const directory = join(root, "cassettes");
    const usageFile = join(root, "usage.ndjson");
    await record(directory, "cli-list-example");
    await appendUsageEvent({ type: "replay", cassette: "cli-list-example", turn: 0, timestamp: new Date().toISOString(), costSavedUsd: 0.01 }, usageFile);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["list", "--json", "--dir", directory])).resolves.toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("cli-list-example");
    log.mockClear();
    await expect(runCli(["stats", "--json", "--dir", directory])).resolves.toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain('"moneySavedUsd": 0.01');
    log.mockClear();
    await expect(runCli(["verify", "--dir", directory])).resolves.toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("Verified 1 cassette");
  });

  it("keeps prune dry by default and deletes only after --yes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentcassette-prune-"));
    directories.push(root);
    const directory = join(root, "cassettes");
    const name = ["runtime", "orphan", String(Date.now())].join("-");
    await record(directory, name);
    const store = new FileCassetteStore(directory);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runCli(["prune", "--dir", directory])).resolves.toBe(0);
    expect(await store.exists(name)).toBe(true);
    expect(log.mock.calls.flat().join("\n")).toContain("Would prune");
    await expect(runCli(["prune", "--yes", "--dir", directory])).resolves.toBe(1);
    expect(await store.exists(name)).toBe(true);
    await expect(runCli(["prune", "--yes", "--name", name, "--dir", directory])).resolves.toBe(0);
    expect(await store.exists(name)).toBe(false);
  });
});
