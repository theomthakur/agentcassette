import { asJsonValue, isRecord, normalizeRole, textPart, unknownToContent } from "../core/canonical.js";
import type { ProviderAdapter, SemanticMessage, SemanticRequest, SemanticResponse, ToolCall } from "../core/types.js";
import { normalizeTools, normalizeUsage, records, stringValue } from "./common.js";

export function anthropic<Request = unknown, Response = unknown>(): ProviderAdapter<Request, Response> {
  return {
    provider: "anthropic",
    normalizeRequest: (request) => normalizeAnthropicRequest(request),
    normalizeResponse: (response) => normalizeAnthropicResponse(response),
    replayResponse: (response) => replayAnthropicResponse(response) as Response,
  };
}

export function normalizeAnthropicRequest(value: unknown): SemanticRequest {
  const request = isRecord(value) ? value : {};
  const messages: SemanticMessage[] = [];
  if (request.system !== undefined) messages.push({ role: "system", content: unknownToContent(request.system) });
  for (const source of records(request.messages)) {
    const role = normalizeRole(source.role);
    if (!Array.isArray(source.content)) {
      messages.push({ role, content: unknownToContent(source.content) });
      continue;
    }
    for (const block of source.content) {
      if (!isRecord(block)) {
        messages.push({ role, content: unknownToContent(block) });
        continue;
      }
      if (block.type === "tool_result") {
        const message: SemanticMessage = { role: "tool", content: unknownToContent(block.content) };
        const id = stringValue(block.tool_use_id);
        if (id !== undefined) message.toolCallId = id;
        messages.push(message);
        continue;
      }
      if (block.type === "tool_use" && typeof block.name === "string") {
        const call: ToolCall = { name: block.name, arguments: asJsonValue(block.input) };
        const id = stringValue(block.id);
        if (id !== undefined) call.id = id;
        messages.push({ role: "assistant", content: [], toolCalls: [call] });
        continue;
      }
      messages.push({ role, content: block.type === "text" ? unknownToContent(block.text) : unknownToContent(block) });
    }
  }
  const normalized: SemanticRequest = { messages, tools: normalizeTools(request.tools, "anthropic") };
  const model = stringValue(request.model);
  if (model !== undefined) normalized.model = model;
  return normalized;
}

export function normalizeAnthropicResponse(value: unknown): SemanticResponse {
  const response = isRecord(value) ? value : {};
  const content = [];
  const toolCalls: ToolCall[] = [];
  const sequence: NonNullable<SemanticResponse["sequence"]> = [];
  for (const block of records(response.content)) {
    if (block.type === "text" && typeof block.text === "string") {
      const part = textPart(block.text);
      content.push(part);
      sequence.push({ type: "content", part });
    }
    if (block.type === "tool_use" && typeof block.name === "string") {
      const call: ToolCall = { name: block.name, arguments: asJsonValue(block.input) };
      const id = stringValue(block.id);
      if (id !== undefined) call.id = id;
      toolCalls.push(call);
      sequence.push({ type: "toolCall", call });
    }
  }
  const normalized: SemanticResponse = { content, toolCalls, sequence };
  const id = stringValue(response.id);
  if (id !== undefined) normalized.id = id;
  const model = stringValue(response.model);
  if (model !== undefined) normalized.model = model;
  const finishReason = stringValue(response.stop_reason);
  if (finishReason !== undefined) normalized.finishReason = finishReason;
  const usage = normalizeUsage(response.usage, ["input_tokens"], ["output_tokens"]);
  if (usage !== undefined) normalized.usage = usage;
  return normalized;
}

function replayAnthropicResponse(response: SemanticResponse): unknown {
  return {
    id: response.id ?? "msg_agentcassette_replay",
    model: response.model,
    type: "message",
    role: "assistant",
    content: response.sequence
      ? response.sequence.map((item, index) => item.type === "content"
        ? anthropicContentBlock(item.part)
        : {
            type: "tool_use",
            id: item.call.id ?? `toolu_replay_${index}`,
            name: item.call.name,
            input: item.call.arguments,
          })
      : [
          ...response.content.map(anthropicContentBlock),
          ...response.toolCalls.map((call, index) => ({
            type: "tool_use",
            id: call.id ?? `toolu_replay_${index}`,
            name: call.name,
            input: call.arguments,
          })),
        ],
    stop_reason: response.finishReason ?? (response.toolCalls.length > 0 ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: response.usage ? {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
    } : undefined,
  };
}

function anthropicContentBlock(part: SemanticResponse["content"][number]): { type: "text"; text: string } {
  return part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "text", text: JSON.stringify(part.type === "json" ? part.value : part.source) };
}
