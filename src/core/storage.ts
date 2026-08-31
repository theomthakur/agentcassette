import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Cassette, ContentPart, JsonValue, SemanticMessage, SemanticRequest, SemanticResponse, ToolCall } from "./types.js";

export interface CassetteStore {
  exists(name: string): Promise<boolean>;
  read(name: string): Promise<Cassette>;
  write(cassette: Cassette): Promise<void>;
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}

export class FileCassetteStore implements CassetteStore {
  readonly directory: string;

  constructor(directory = ".agentcassette/cassettes") {
    this.directory = resolve(directory);
  }

  async exists(name: string): Promise<boolean> {
    try {
      await stat(this.pathFor(name));
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  async read(name: string): Promise<Cassette> {
    const source = await readFile(this.pathFor(name), "utf8");
    return parseCassette(source, name);
  }

  async write(cassette: Cassette): Promise<void> {
    const destination = this.pathFor(cassette.name);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(cassette, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
  }

  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -5))
        .filter(isValidCassetteName)
        .sort();
    } catch (error) {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    }
  }

  async remove(name: string): Promise<void> {
    await rm(this.pathFor(name), { force: true });
  }

  pathFor(name: string): string {
    if (!isValidCassetteName(name)) {
      throw new Error("Cassette names must start with a lowercase letter or digit and contain only lowercase letters, digits, dots, underscores, or hyphens.");
    }
    return join(this.directory, `${name}.json`);
  }
}

export class MemoryCassetteStore implements CassetteStore {
  readonly cassettes = new Map<string, Cassette>();

  async exists(name: string): Promise<boolean> {
    return this.cassettes.has(name);
  }

  async read(name: string): Promise<Cassette> {
    const cassette = this.cassettes.get(name);
    if (!cassette) throw new Error(`Cassette "${name}" does not exist.`);
    return structuredClone(cassette);
  }

  async write(cassette: Cassette): Promise<void> {
    this.cassettes.set(cassette.name, structuredClone(cassette));
  }

  async list(): Promise<string[]> {
    return [...this.cassettes.keys()].sort();
  }

  async remove(name: string): Promise<void> {
    this.cassettes.delete(name);
  }
}

export function parseCassette(source: string, expectedName?: string): Cassette {
  const value: unknown = JSON.parse(source);
  if (!isCassette(value)) throw new Error(`Invalid agentcassette file${expectedName ? `: ${expectedName}` : ""}.`);
  if (expectedName !== undefined && value.name !== expectedName) {
    throw new Error(`Cassette identity mismatch: expected "${expectedName}", file contains "${value.name}".`);
  }
  return value;
}

function isValidCassetteName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/u.test(name);
}

function isCassette(value: unknown): value is Cassette {
  if (!isObject(value)) return false;
  return value.schemaVersion === 1
    && typeof value.name === "string"
    && isValidCassetteName(value.name)
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && (value.metadata === undefined || isMetadata(value.metadata))
    && Array.isArray(value.turns)
    && value.turns.every((turn, index) => isTurn(turn, index));
}

function isTurn(value: unknown, index: number): boolean {
  return isObject(value)
    && value.index === index
    && typeof value.fingerprint === "string"
    && isRequest(value.request)
    && Array.isArray(value.events)
    && value.events.every(isEvent)
    && isResponse(value.response);
}

function isMetadata(value: unknown): boolean {
  return isObject(value)
    && (value.provider === undefined || typeof value.provider === "string")
    && (value.testFile === undefined || typeof value.testFile === "string")
    && (value.tags === undefined || (Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string")))
    && (value.fingerprint === undefined || value.fingerprint === "default" || value.fingerprint === "custom");
}

function isEvent(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === "messages.sent") return Array.isArray(value.messages) && value.messages.every(isMessage);
  if (value.type === "tool.result.returned") return isMessage(value.message);
  if (value.type === "tool.call.proposed") return isToolCall(value.call);
  return value.type === "output.final" && Array.isArray(value.content) && value.content.every(isContentPart);
}

function isRequest(value: unknown): value is SemanticRequest {
  return isObject(value)
    && Array.isArray(value.messages)
    && value.messages.every(isMessage)
    && Array.isArray(value.tools)
    && value.tools.every((tool) => isObject(tool) && typeof tool.name === "string" && isJsonValue(tool.inputSchema))
    && (value.model === undefined || typeof value.model === "string");
}

function isResponse(value: unknown): value is SemanticResponse {
  return isObject(value)
    && Array.isArray(value.content)
    && value.content.every(isContentPart)
    && Array.isArray(value.toolCalls)
    && value.toolCalls.every(isToolCall)
    && (value.sequence === undefined || (Array.isArray(value.sequence) && value.sequence.every(isResponseItem)))
    && (value.id === undefined || typeof value.id === "string")
    && (value.model === undefined || typeof value.model === "string")
    && (value.finishReason === undefined || typeof value.finishReason === "string")
    && (value.usage === undefined || (isObject(value.usage)
      && typeof value.usage.inputTokens === "number"
      && typeof value.usage.outputTokens === "number"
      && typeof value.usage.totalTokens === "number"
      && (value.usage.costUsd === undefined || typeof value.usage.costUsd === "number")));
}

function isMessage(value: unknown): value is SemanticMessage {
  return isObject(value)
    && (value.role === "system" || value.role === "user" || value.role === "assistant" || value.role === "tool")
    && Array.isArray(value.content)
    && value.content.every(isContentPart)
    && (value.name === undefined || typeof value.name === "string")
    && (value.toolCallId === undefined || typeof value.toolCallId === "string")
    && (value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(isToolCall)));
}

function isContentPart(value: unknown): value is ContentPart {
  if (!isObject(value)) return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "image") return typeof value.source === "string";
  return value.type === "json" && isJsonValue(value.value);
}

function isResponseItem(value: unknown): boolean {
  return isObject(value)
    && ((value.type === "content" && isContentPart(value.part))
      || (value.type === "toolCall" && isToolCall(value.call)));
}

function isToolCall(value: unknown): value is ToolCall {
  return isObject(value)
    && typeof value.name === "string"
    && isJsonValue(value.arguments)
    && (value.id === undefined || typeof value.id === "string");
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isObject(value) && Object.values(value).every(isJsonValue);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
