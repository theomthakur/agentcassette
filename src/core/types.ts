export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "json"; value: JsonValue }
  | { type: "image"; source: string };

export interface SemanticMessage {
  role: MessageRole;
  content: ContentPart[];
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonValue;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments: JsonValue;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface SemanticRequest {
  messages: SemanticMessage[];
  tools: ToolDefinition[];
  model?: string;
}

export type SemanticResponseItem =
  | { type: "content"; part: ContentPart }
  | { type: "toolCall"; call: ToolCall };

export interface SemanticResponse {
  content: ContentPart[];
  toolCalls: ToolCall[];
  sequence?: SemanticResponseItem[];
  id?: string;
  model?: string;
  finishReason?: string;
  usage?: TokenUsage;
}

export type SemanticEvent =
  | { type: "messages.sent"; messages: SemanticMessage[] }
  | { type: "tool.result.returned"; message: SemanticMessage }
  | { type: "tool.call.proposed"; call: ToolCall }
  | { type: "output.final"; content: ContentPart[] };

export interface RecordedTurn {
  index: number;
  fingerprint: string;
  request: SemanticRequest;
  events: SemanticEvent[];
  response: SemanticResponse;
}

export interface CassetteMetadata {
  provider?: string;
  testFile?: string;
  tags?: string[];
  fingerprint?: "default" | "custom";
}

export interface Cassette {
  schemaVersion: 1;
  name: string;
  createdAt: string;
  updatedAt: string;
  turns: RecordedTurn[];
  metadata?: CassetteMetadata;
}

export type CassetteMode = "record" | "replay" | "auto";

export interface ProviderAdapter<Request, Response> {
  readonly provider: string;
  normalizeRequest(request: Request): SemanticRequest;
  normalizeResponse(response: Response): SemanticResponse;
  replayResponse(response: SemanticResponse): Response;
}

export type ClientBoundary<Request, Response> = (request: Request) => Promise<Response>;
export type FingerprintFunction = (request: SemanticRequest) => string;

export interface CostContext {
  request: SemanticRequest;
  response: SemanticResponse;
}

export type CostCalculator = (context: CostContext) => number | undefined;
