import type { SemanticEvent, SemanticRequest, SemanticResponse } from "./types.js";

export function eventsForTurn(request: SemanticRequest, response: SemanticResponse): SemanticEvent[] {
  const events: SemanticEvent[] = [{ type: "messages.sent", messages: request.messages }];
  for (const message of request.messages) {
    if (message.role === "tool") events.push({ type: "tool.result.returned", message });
  }
  for (const call of response.toolCalls) events.push({ type: "tool.call.proposed", call });
  if (response.content.length > 0) events.push({ type: "output.final", content: response.content });
  return events;
}
