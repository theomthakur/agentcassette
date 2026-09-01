import { createHash } from "node:crypto";
import { contentToText, normalizeSemanticText, stableStringify } from "./canonical.js";
import type { FingerprintFunction, SemanticRequest } from "./types.js";

export const defaultFingerprint: FingerprintFunction = (request) => {
  const finalUser = [...request.messages].reverse().find((message) => message.role === "user");
  const shape = request.messages.map((message) => ({
    role: message.role,
    content: message.content.map((part) => part.type),
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
  }));
  const tools = request.tools.map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: normalizeSemanticText(tool.description) }),
    inputSchema: tool.inputSchema,
  }));
  const semanticFinalUserTurn = finalUser
    ? normalizeSemanticText(contentToText(finalUser.content))
    : "";
  const systemInstructions = request.messages
    .filter((message) => message.role === "system")
    .map((message) => normalizeSemanticText(contentToText(message.content)));
  const decisionHistory = request.messages.flatMap((message, index) => {
    if (message.role === "system" || message === finalUser) return [];
    return [{
      index,
      role: message.role,
      content: normalizeSemanticText(contentToText(message.content)),
      toolCalls: message.toolCalls ?? [],
      ...(message.name === undefined ? {} : { name: message.name }),
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    }];
  });
  const canonical = stableStringify({
    model: request.model ?? null,
    tools,
    shape,
    systemInstructions,
    decisionHistory,
    semanticFinalUserTurn,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
};

export function explainDefaultFingerprint(request: SemanticRequest): {
  conversationRoles: string[];
  finalUserTurn: string;
  toolNames: string[];
} {
  const finalUser = [...request.messages].reverse().find((message) => message.role === "user");
  return {
    conversationRoles: request.messages.map((message) => message.role),
    finalUserTurn: finalUser ? normalizeSemanticText(contentToText(finalUser.content)) : "",
    toolNames: request.tools.map((tool) => tool.name),
  };
}
