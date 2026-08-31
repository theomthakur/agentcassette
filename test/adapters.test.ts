import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { semantic, type SemanticRequest, type SemanticResponse } from "../src/index.js";
import { withJestCassette } from "../src/adapters/jest.js";
import { withVitestCassette } from "../src/adapters/vitest.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const input: SemanticRequest = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [] };
const output: SemanticResponse = {
  content: [{ type: "text", text: "hi" }],
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.002 },
};

describe("test-runner adapters", () => {
  it("wraps Vitest in one call and tracks replay savings", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentcassette-adapter-"));
    directories.push(root);
    const directory = join(root, "cassettes");
    const usageFile = join(root, "usage.ndjson");
    const record = await withVitestCassette({
      name: "vitest-example",
      mode: "record",
      directory,
      usageFile,
      adapter: semantic(),
      client: async () => output,
      testFile: "test/example.test.ts",
    });
    await record(input);

    const network = vi.fn(async () => output);
    const replay = await withVitestCassette({
      name: "vitest-example",
      mode: "replay",
      directory,
      usageFile,
      adapter: semantic(),
      client: network,
    });
    await replay(input);
    expect(network).not.toHaveBeenCalled();
    const usage = await readFile(usageFile, "utf8");
    expect(usage).toContain('"type":"replay"');
    expect(usage).toContain('"costSavedUsd":0.002');
  });

  it("rejects invalid environment modes instead of falling back to live auto mode", async () => {
    const previous = process.env.AGENTCASSETTE_MODE;
    process.env.AGENTCASSETTE_MODE = "repaly";
    try {
      await expect(withVitestCassette({
        name: "invalid-mode",
        adapter: semantic(),
        client: async () => output,
      })).rejects.toThrow("Invalid AGENTCASSETTE_MODE");
    } finally {
      if (previous === undefined) delete process.env.AGENTCASSETTE_MODE;
      else process.env.AGENTCASSETTE_MODE = previous;
    }
  });

  it("provides the same one-call API for Jest", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentcassette-jest-"));
    directories.push(root);
    const client = await withJestCassette({
      name: "jest-example",
      mode: "record",
      directory: join(root, "cassettes"),
      usageFile: join(root, "usage.ndjson"),
      adapter: semantic(),
      client: async () => output,
    });
    await expect(client(input)).resolves.toEqual(output);
  });
});
