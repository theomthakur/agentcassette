import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileCassetteStore,
  createCassetteClient,
  parseCassette,
  redact,
  semantic,
  type Cassette,
  type SemanticRequest,
  type SemanticResponse,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const request: SemanticRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "Email me at dev@example.com" }] }],
  tools: [],
};
const response: SemanticResponse = { content: [{ type: "text", text: "Call +1 (555) 123-4567" }], toolCalls: [] };

describe("redaction and storage", () => {
  it("redacts common secrets and PII plus custom rules", () => {
    const value = redact({
      apiKey: "sk-secret",
      note: "Contact dev@example.com with Bearer abc.def",
      tenant: "customer-42",
    }, {
      rules: [{ name: "tenant", match: ({ key }) => key === "tenant", replacement: "[TENANT]" }],
    });
    expect(value).toEqual({
      apiKey: "[REDACTED]",
      note: "Contact [REDACTED_EMAIL] with Bearer [REDACTED]",
      tenant: "[TENANT]",
    });
  });

  it("can disable all built-in redaction while retaining custom rules", () => {
    expect(redact({ email: "dev@example.com", apiKey: "secret" }, { includeDefaults: false })).toEqual({
      email: "dev@example.com",
      apiKey: "secret",
    });
  });

  it("rejects unsafe names and malformed cassette turns at the storage boundary", () => {
    const store = new FileCassetteStore(".agentcassette/test-only");
    expect(() => store.pathFor("tenant/a")).toThrow("Cassette names");
    expect(() => store.pathFor("Tenant-A")).toThrow("Cassette names");
    expect(() => parseCassette(JSON.stringify({
      schemaVersion: 1,
      name: "broken",
      createdAt: "now",
      updatedAt: "now",
      turns: [null],
    }))).toThrow("Invalid agentcassette");
  });

  it("writes readable JSON without sensitive source values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcassette-"));
    temporaryDirectories.push(directory);
    const store = new FileCassetteStore(directory);
    const client = await createCassetteClient({
      name: "redacted",
      mode: "record",
      store,
      adapter: semantic(),
      client: async () => response,
    });
    await client(request);
    const source = await readFile(store.pathFor("redacted"), "utf8");
    expect(source).toContain("[REDACTED_EMAIL]");
    expect(source).toContain("[REDACTED_PHONE]");
    expect(source).not.toContain("dev@example.com");
    expect((JSON.parse(source) as Cassette).turns).toHaveLength(1);

    const malformedEvent = JSON.parse(source) as { turns: Array<{ events: unknown[] }> };
    const firstTurn = malformedEvent.turns[0];
    if (!firstTurn) throw new Error("Expected a recorded turn");
    firstTurn.events = [{ type: "output.final" }];
    expect(() => parseCassette(JSON.stringify(malformedEvent))).toThrow("Invalid agentcassette");

    const malformedMetadata = JSON.parse(source) as { metadata: unknown };
    malformedMetadata.metadata = { provider: 42 };
    expect(() => parseCassette(JSON.stringify(malformedMetadata))).toThrow("Invalid agentcassette");
  });
});
