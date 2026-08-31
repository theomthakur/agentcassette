import { describe, expect, it } from "vitest";
import {
  anthropic,
  google,
  normalizeAnthropicRequest,
  normalizeAnthropicResponse,
  normalizeGoogleRequest,
  normalizeGoogleResponse,
  normalizeOpenAIRequest,
  normalizeOpenAIResponse,
  openAI,
} from "../src/index.js";

describe("provider normalization", () => {
  it("normalizes and replays OpenAI and compatible shapes", () => {
    const request = normalizeOpenAIRequest({
      model: "gpt-test",
      messages: [
        { role: "user", content: "Find weather" },
        { role: "assistant", content: null, tool_calls: [{ id: "old_call", function: { name: "weather", arguments: "{\"city\":\"Paris\"}" } }] },
        { role: "tool", tool_call_id: "old_call", content: "Sunny" },
      ],
      tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
    });
    const response = normalizeOpenAIResponse({
      choices: [{ message: { content: null, tool_calls: [{ id: "call_1", function: { name: "weather", arguments: "{\"city\":\"Paris\"}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    });
    expect(request.tools[0]?.name).toBe("weather");
    expect(request.messages[1]?.toolCalls?.[0]).toMatchObject({ id: "old_call", name: "weather", arguments: { city: "Paris" } });
    expect(response.toolCalls[0]?.arguments).toEqual({ city: "Paris" });
    const replayed = openAI<unknown, Record<string, unknown>>().replayResponse(response);
    expect(replayed.choices).toBeDefined();
  });

  it("normalizes Anthropic tool use and tool results", () => {
    const request = normalizeAnthropicRequest({
      system: "Be useful",
      messages: [
        { role: "user", content: [{ type: "text", text: "Find weather" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "Sunny" }] },
      ],
      tools: [{ name: "weather", input_schema: { type: "object" } }],
    });
    const response = normalizeAnthropicResponse({
      content: [{ type: "tool_use", id: "tool_1", name: "weather", input: { city: "Paris" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 9, output_tokens: 2 },
    });
    expect(request.messages.map((message) => message.role)).toEqual(["system", "user", "tool"]);
    expect(response.toolCalls[0]?.name).toBe("weather");
    const replayed = anthropic<unknown, Record<string, unknown>>().replayResponse(response);
    expect(replayed.type).toBe("message");
  });

  it("preserves Anthropic mixed block order", () => {
    const request = normalizeAnthropicRequest({
      messages: [{
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "one", content: "first" },
          { type: "text", text: "between" },
          { type: "tool_result", tool_use_id: "two", content: "second" },
        ],
      }],
    });
    expect(request.messages.map((message) => message.role)).toEqual(["tool", "user", "tool"]);
    expect(request.messages[0]?.toolCallId).toBe("one");
    expect(request.messages[2]?.toolCallId).toBe("two");
  });

  it("preserves mixed Anthropic response block order during replay", () => {
    const normalized = normalizeAnthropicResponse({
      content: [
        { type: "tool_use", id: "one", name: "first", input: {} },
        { type: "text", text: "between" },
        { type: "tool_use", id: "two", name: "second", input: {} },
      ],
    });
    const replayed = anthropic<unknown, { content: Array<Record<string, unknown>> }>().replayResponse(normalized);
    expect(replayed.content.map((block) => block.type)).toEqual(["tool_use", "text", "tool_use"]);
  });

  it("normalizes Google function calls and responses", () => {
    const request = normalizeGoogleRequest({
      config: {
        systemInstruction: { parts: [{ text: "Be useful" }] },
        tools: [{ functionDeclarations: [{ name: "weather", parametersJsonSchema: { type: "object" } }] }],
      },
      contents: [
        { role: "user", parts: [{ text: "Find weather" }] },
        { role: "model", parts: [{ functionCall: { name: "weather", args: { city: "Paris" } } }] },
        { role: "user", parts: [{ functionResponse: { name: "weather", response: { result: "Sunny" } } }] },
      ],
    });
    const response = normalizeGoogleResponse({
      candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "weather", args: { city: "Paris" } } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
    });
    expect(request.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(request.messages[2]?.toolCalls?.[0]?.name).toBe("weather");
    expect(request.tools[0]?.inputSchema).toEqual({ type: "object" });
    expect(response.toolCalls[0]?.arguments).toEqual({ city: "Paris" });
    const replayed = google<unknown, Record<string, unknown>>().replayResponse(response);
    expect(replayed.candidates).toBeDefined();
  });
});
