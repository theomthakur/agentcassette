import { isRecord, messageFromUnknown } from "../core/canonical.js";
import type { ProviderAdapter, SemanticRequest, SemanticResponse, ToolCall } from "../core/types.js";
import { contentParts, contentToProviderText, normalizeTools, normalizeUsage, parseJson, records, stringValue } from "./common.js";

export function openAI<Request = unknown, Response = unknown>(): ProviderAdapter<Request, Response> {
  return {
    provider: "openai",
    normalizeRequest: (request) => normalizeOpenAIRequest(request),
    normalizeResponse: (response) => normalizeOpenAIResponse(response),
    replayResponse: (response) => replayOpenAIResponse(response) as Response,
  };
}

export const openAICompatible = openAI;

export function normalizeOpenAIRequest(value: unknown): SemanticRequest {
  const request = isRecord(value) ? value : {};
  const normalized: SemanticRequest = {
    messages: (Array.isArray(request.messages) ? request.messages : []).map((source) => {
      const message = messageFromUnknown(source);
      if (isRecord(source)) {
        const toolCalls = openAIToolCalls(source.tool_calls ?? source.toolCalls);
        if (toolCalls.length > 0) message.toolCalls = toolCalls;
      }
      return message;
    }),
    tools: normalizeTools(request.tools, "openai"),
  };
  const model = stringValue(request.model);
  if (model !== undefined) normalized.model = model;
  return normalized;
}

export function normalizeOpenAIResponse(value: unknown): SemanticResponse {
  const response = isRecord(value) ? value : {};
  const choice = records(response.choices)[0];
  const message = choice && isRecord(choice.message) ? choice.message : {};
  const toolCalls = openAIToolCalls(message.tool_calls ?? message.toolCalls);
  const normalized: SemanticResponse = {
    content: contentParts(message.content),
    toolCalls,
  };
  const id = stringValue(response.id);
  if (id !== undefined) normalized.id = id;
  const model = stringValue(response.model);
  if (model !== undefined) normalized.model = model;
  const finishReason = choice ? stringValue(choice.finish_reason ?? choice.finishReason) : undefined;
  if (finishReason !== undefined) normalized.finishReason = finishReason;
  const usage = normalizeUsage(response.usage, ["prompt_tokens", "input_tokens"], ["completion_tokens", "output_tokens"], ["total_tokens"]);
  if (usage !== undefined) normalized.usage = usage;
  return normalized;
}

function replayOpenAIResponse(response: SemanticResponse): unknown {
  return {
    id: response.id ?? "agentcassette-replay",
    object: "chat.completion",
    created: 0,
    model: response.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: contentToProviderText(response.content),
        tool_calls: response.toolCalls.map((call, index) => ({
          id: call.id ?? `call_replay_${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      },
      finish_reason: response.finishReason ?? (response.toolCalls.length > 0 ? "tool_calls" : "stop"),
    }],
    usage: response.usage ? {
      prompt_tokens: response.usage.inputTokens,
      completion_tokens: response.usage.outputTokens,
      total_tokens: response.usage.totalTokens,
    } : undefined,
  };
}

function openAIToolCalls(value: unknown): ToolCall[] {
  return records(value).flatMap((item) => {
    const fn = isRecord(item.function) ? item.function : item;
    const name = stringValue(fn.name);
    if (!name) return [];
    const call: ToolCall = { name, arguments: parseJson(fn.arguments) };
    const id = stringValue(item.id);
    if (id !== undefined) call.id = id;
    return [call];
  });
}
