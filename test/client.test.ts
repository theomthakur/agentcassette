import { describe, expect, it, vi } from "vitest";
import {
  CassetteDivergenceError,
  MemoryCassetteStore,
  createCassetteClient,
  semantic,
  type SemanticRequest,
  type SemanticResponse,
} from "../src/index.js";

function request(text: string, system = "You are a helpful assistant."): SemanticRequest {
  return {
    model: "test-model",
    messages: [
      { role: "system", content: [{ type: "text", text: system }] },
      { role: "user", content: [{ type: "text", text }] },
    ],
    tools: [{
      name: "weather",
      description: "Get weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    }],
  };
}

function response(text: string, costUsd = 0.01): SemanticResponse {
  return {
    content: [{ type: "text", text }],
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, costUsd },
  };
}

describe("createCassetteClient", () => {
  it("records semantic decisions and replays with zero client calls", async () => {
    const store = new MemoryCassetteStore();
    const live = vi.fn(async () => response("sunny"));
    const recorder = await createCassetteClient({
      name: "weather-agent",
      mode: "record",
      store,
      adapter: semantic(),
      client: live,
    });

    await expect(recorder(request("Weather in Paris?"))).resolves.toEqual(response("sunny"));
    expect(live).toHaveBeenCalledOnce();
    const cassette = await store.read("weather-agent");
    expect(cassette.turns[0]?.events.map((event) => event.type)).toEqual(["messages.sent", "output.final"]);

    const forbiddenNetwork = vi.fn(async () => response("must not happen"));
    const replay = await createCassetteClient({
      name: "weather-agent",
      mode: "replay",
      store,
      adapter: semantic(),
      client: forbiddenNetwork,
    });
    await expect(replay(request("Weather in Paris?"))).resolves.toEqual(response("sunny"));
    expect(forbiddenNetwork).not.toHaveBeenCalled();
  });

  it("ignores whitespace and timestamps when behavioral inputs are unchanged", async () => {
    const store = new MemoryCassetteStore();
    const recorder = await createCassetteClient({
      name: "stable-match",
      mode: "record",
      store,
      adapter: semantic(),
      client: async () => response("ok"),
    });
    await recorder(request("Run at 2026-08-31T10:20:30Z   with this input", "Original boilerplate"));

    const replay = await createCassetteClient({
      name: "stable-match",
      mode: "replay",
      store,
      adapter: semantic(),
    });
    await expect(replay(request("Run at 2027-01-01T01:02:03Z with this input", "Original boilerplate"))).resolves.toEqual(response("ok"));
  });

  it("rejects replay when the system instruction changes", async () => {
    const store = new MemoryCassetteStore();
    const recorder = await createCassetteClient({
      name: "system-change",
      mode: "record",
      store,
      adapter: semantic(),
      client: async () => response("ok"),
    });
    await recorder(request("Summarize this", "Answer in one sentence"));

    const replay = await createCassetteClient({
      name: "system-change",
      mode: "replay",
      store,
      adapter: semantic(),
    });
    await expect(
      replay(request("Summarize this", "Return the full source verbatim")),
    ).rejects.toBeInstanceOf(CassetteDivergenceError);
  });

  it("rejects replay when the requested model changes", async () => {
    const store = new MemoryCassetteStore();
    const recorder = await createCassetteClient({
      name: "model-change",
      mode: "record",
      store,
      adapter: semantic(),
      client: async () => response("ok"),
    });
    await recorder(request("Summarize this"));

    const changed = { ...request("Summarize this"), model: "different-model" };
    const replay = await createCassetteClient({
      name: "model-change",
      mode: "replay",
      store,
      adapter: semantic(),
    });
    await expect(replay(changed)).rejects.toBeInstanceOf(CassetteDivergenceError);
  });

  it("rejects stale replay when a tool result changes", async () => {
    const store = new MemoryCassetteStore();
    const withToolResult = (result: number): SemanticRequest => ({
      messages: [
        { role: "user", content: [{ type: "text", text: "Calculate the total" }] },
        { role: "assistant", content: [], toolCalls: [{ id: "call-1", name: "sum", arguments: { values: [1, 2] } }] },
        { role: "tool", toolCallId: "call-1", content: [{ type: "json", value: { result } }] },
      ],
      tools: [{ name: "sum", inputSchema: { type: "object" } }],
    });
    const recorder = await createCassetteClient({
      name: "tool-result-change",
      mode: "record",
      store,
      adapter: semantic(),
      client: async () => response("3"),
    });
    await recorder(withToolResult(3));
    const replay = await createCassetteClient({ name: "tool-result-change", mode: "replay", store, adapter: semantic() });
    await expect(replay(withToolResult(4))).rejects.toBeInstanceOf(CassetteDivergenceError);
  });

  it("rejects stale replay when an earlier user instruction changes", async () => {
    const store = new MemoryCassetteStore();
    const conversation = (first: string): SemanticRequest => ({
      messages: [
        { role: "user", content: [{ type: "text", text: first }] },
        { role: "assistant", content: [{ type: "text", text: "Understood" }] },
        { role: "user", content: [{ type: "text", text: "Continue" }] },
      ],
      tools: [],
    });
    const recorder = await createCassetteClient({
      name: "prior-user-change",
      mode: "record",
      store,
      adapter: semantic(),
      client: async () => response("done"),
    });
    await recorder(conversation("Use metric units"));
    const replay = await createCassetteClient({ name: "prior-user-change", mode: "replay", store, adapter: semantic() });
    await expect(replay(conversation("Use imperial units"))).rejects.toBeInstanceOf(CassetteDivergenceError);
  });

  it("reports the divergent turn, expected and actual values, and structured paths", async () => {
    const store = new MemoryCassetteStore();
    const recorder = await createCassetteClient({
      name: "divergence-example",
      mode: "record",
      store,
      adapter: semantic(),
      client: async () => response("ok"),
    });
    await recorder(request("Book Paris"));
    const replay = await createCassetteClient({ name: "divergence-example", mode: "replay", store, adapter: semantic() });

    const error = await replay(request("Book Berlin")).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CassetteDivergenceError);
    expect((error as CassetteDivergenceError).report.turn).toBe(0);
    expect((error as Error).message).toContain("diverged at turn 1");
    expect((error as Error).message).toContain("$.messages[1].content[0].text");
    expect((error as Error).message).toContain("Book Paris");
    expect((error as Error).message).toContain("Book Berlin");
  });

  it("replays the first N turns and sends only the tail to the live client", async () => {
    const store = new MemoryCassetteStore();
    const recorder = await createCassetteClient({
      name: "partial",
      mode: "record",
      store,
      adapter: semantic(),
      client: async (input) => response(`recorded:${input.messages.length}`),
    });
    await recorder(request("first"));
    await recorder(request("second"));

    const live = vi.fn(async () => response("live-tail"));
    const partial = await createCassetteClient({
      name: "partial",
      mode: "replay",
      replayTurns: 1,
      store,
      adapter: semantic(),
      client: live,
    });
    await expect(partial(request("first"))).resolves.toEqual(response("recorded:2"));
    await expect(partial(request("changed tail is allowed"))).resolves.toEqual(response("live-tail"));
    expect(live).toHaveBeenCalledOnce();
  });

  it("auto records once and replays thereafter", async () => {
    const store = new MemoryCassetteStore();
    const firstLive = vi.fn(async () => response("recorded"));
    const first = await createCassetteClient({ name: "auto", store, adapter: semantic(), client: firstLive });
    expect(first.mode).toBe("record");
    await first(request("hello"));

    const secondLive = vi.fn(async () => response("network"));
    const second = await createCassetteClient({ name: "auto", store, adapter: semantic(), client: secondLive });
    expect(second.mode).toBe("replay");
    await expect(second(request("hello"))).resolves.toEqual(response("recorded"));
    expect(secondLive).not.toHaveBeenCalled();
  });
});
