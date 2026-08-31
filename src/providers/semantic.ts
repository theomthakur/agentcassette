import type { ProviderAdapter, SemanticRequest, SemanticResponse } from "../core/types.js";

export function semantic(): ProviderAdapter<SemanticRequest, SemanticResponse> {
  return {
    provider: "semantic",
    normalizeRequest: (request) => structuredClone(request),
    normalizeResponse: (response) => structuredClone(response),
    replayResponse: (response) => structuredClone(response),
  };
}
