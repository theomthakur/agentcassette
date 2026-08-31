import { asJsonValue, isRecord, normalizeRole, textPart, unknownToContent } from "../core/canonical.js";
import type { ProviderAdapter, SemanticMessage, SemanticRequest, SemanticResponse, ToolCall } from "../core/types.js";
import { normalizeTools, normalizeUsage, records, stringValue } from "./common.js";

export function google<Request = unknown, Response = unknown>(): ProviderAdapter<Request, Response> {
  return {
    provider: "google",
    normalizeRequest: (request) => normalizeGoogleRequest(request),
    normalizeResponse: (response) => normalizeGoogleResponse(response),
    replayResponse: (response) => replayGoogleResponse(response) as Response,
  };
}

export function normalizeGoogleRequest(value: unknown): SemanticRequest {
  const request = isRecord(value) ? value : {};
  const config = isRecord(request.config) ? request.config : {};
  const messages: SemanticMessage[] = [];
  const system = request.systemInstruction ?? request.system_instruction ?? config.systemInstruction ?? config.system_instruction;
  if (system !== undefined) {
    const content = isRecord(system) ? googleTextParts(system.parts) : unknownToContent(system);
    messages.push({ role: "system", content });
  }
  for (const source of records(request.contents)) {
    const role = normalizeRole(source.role);
    if (!Array.isArray(source.parts)) {
      messages.push({ role, content: unknownToContent(source.parts) });
      continue;
    }
    for (const part of source.parts) appendGooglePart(messages, role, part);
  }
  const normalized: SemanticRequest = {
    messages,
    tools: normalizeTools(request.tools ?? config.tools, "google"),
  };
  const model = stringValue(request.model);
  if (model !== undefined) normalized.model = model;
  return normalized;
}

export function normalizeGoogleResponse(value: unknown): SemanticResponse {
  const response = isRecord(value) ? value : {};
  const candidate = records(response.candidates)[0];
  const candidateContent = candidate && isRecord(candidate.content) ? candidate.content : {};
  const content = [];
  const toolCalls: ToolCall[] = [];
  for (const part of records(candidateContent.parts)) {
    if (typeof part.text === "string") content.push(textPart(part.text));
    const fn = part.functionCall ?? part.function_call;
    if (isRecord(fn) && typeof fn.name === "string") {
      toolCalls.push({ name: fn.name, arguments: asJsonValue(fn.args) });
    }
  }
  const normalized: SemanticResponse = { content, toolCalls };
  const id = stringValue(response.responseId ?? response.response_id);
  if (id !== undefined) normalized.id = id;
  const model = stringValue(response.modelVersion ?? response.model_version);
  if (model !== undefined) normalized.model = model;
  const finishReason = candidate ? stringValue(candidate.finishReason ?? candidate.finish_reason) : undefined;
  if (finishReason !== undefined) normalized.finishReason = finishReason;
  const usage = normalizeUsage(response.usageMetadata ?? response.usage_metadata, ["promptTokenCount", "prompt_token_count"], ["candidatesTokenCount", "candidates_token_count"], ["totalTokenCount", "total_token_count"]);
  if (usage !== undefined) normalized.usage = usage;
  return normalized;
}

function appendGooglePart(messages: SemanticMessage[], role: SemanticMessage["role"], value: unknown): void {
  if (!isRecord(value)) {
    messages.push({ role, content: unknownToContent(value) });
    return;
  }
  if (typeof value.text === "string") {
    messages.push({ role, content: [textPart(value.text)] });
    return;
  }
  const functionCall = value.functionCall ?? value.function_call;
  if (isRecord(functionCall) && typeof functionCall.name === "string") {
    messages.push({
      role: "assistant",
      content: [],
      toolCalls: [{ name: functionCall.name, arguments: asJsonValue(functionCall.args) }],
    });
    return;
  }
  const functionResponse = value.functionResponse ?? value.function_response;
  if (isRecord(functionResponse)) {
    const message: SemanticMessage = {
      role: "tool",
      content: [{ type: "json", value: asJsonValue(functionResponse.response) }],
    };
    const name = stringValue(functionResponse.name);
    if (name !== undefined) message.name = name;
    messages.push(message);
    return;
  }
  messages.push({ role, content: [{ type: "json", value: asJsonValue(value) }] });
}

function googleTextParts(value: unknown): ReturnType<typeof unknownToContent> {
  return records(value).flatMap((part) => typeof part.text === "string"
    ? [textPart(part.text)]
    : [{ type: "json" as const, value: asJsonValue(part) }]);
}

function replayGoogleResponse(response: SemanticResponse): unknown {
  return {
    responseId: response.id,
    modelVersion: response.model,
    candidates: [{
      content: {
        role: "model",
        parts: [
          ...response.content.map((part) => part.type === "text" ? { text: part.text } : { text: JSON.stringify(part.type === "json" ? part.value : part.source) }),
          ...response.toolCalls.map((call) => ({ functionCall: { name: call.name, args: call.arguments } })),
        ],
      },
      finishReason: response.finishReason ?? "STOP",
    }],
    usageMetadata: response.usage ? {
      promptTokenCount: response.usage.inputTokens,
      candidatesTokenCount: response.usage.outputTokens,
      totalTokenCount: response.usage.totalTokens,
    } : undefined,
  };
}
