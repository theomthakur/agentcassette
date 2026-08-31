import { CassetteDivergenceError, structuredDiff } from "./diff.js";
import { eventsForTurn } from "./events.js";
import { defaultFingerprint } from "./fingerprint.js";
import { redact, type RedactionOptions } from "./redaction.js";
import { FileCassetteStore, type CassetteStore } from "./storage.js";
import type {
  Cassette,
  CassetteMetadata,
  CassetteMode,
  ClientBoundary,
  CostCalculator,
  FingerprintFunction,
  ProviderAdapter,
  SemanticRequest,
  SemanticResponse,
} from "./types.js";

export interface ReplayContext {
  cassette: string;
  turn: number;
  response: SemanticResponse;
}

export interface CassetteClientOptions<Request, Response> {
  name: string;
  adapter: ProviderAdapter<Request, Response>;
  client?: ClientBoundary<Request, Response>;
  mode?: CassetteMode;
  store?: CassetteStore;
  fingerprint?: FingerprintFunction;
  redaction?: RedactionOptions;
  replayTurns?: number;
  metadata?: CassetteMetadata;
  calculateCost?: CostCalculator;
  onReplay?: (context: ReplayContext) => void | Promise<void>;
}

export interface CassetteClient<Request, Response> {
  (request: Request): Promise<Response>;
  readonly cassetteName: string;
  readonly mode: "record" | "replay";
  readonly turn: number;
}

export async function createCassetteClient<Request, Response>(
  options: CassetteClientOptions<Request, Response>,
): Promise<CassetteClient<Request, Response>> {
  validateOptions(options);
  const store = options.store ?? new FileCassetteStore();
  const requestedMode = options.mode ?? "auto";
  const mode = requestedMode === "auto"
    ? (await store.exists(options.name) ? "replay" : "record")
    : requestedMode;
  const fingerprint = options.fingerprint ?? defaultFingerprint;
  const replayTurns = options.replayTurns ?? Number.POSITIVE_INFINITY;
  let cassette = mode === "replay"
    ? await store.read(options.name)
    : newCassette(options.name, options.adapter.provider, options.metadata, options.fingerprint === undefined);
  let position = 0;
  let queue: Promise<void> = Promise.resolve();

  const invoke = async (input: Request): Promise<Response> => {
    const normalizedRequest = redacted(options.adapter.normalizeRequest(input), options.redaction);
    const actualFingerprint = fingerprint(normalizedRequest);
    const shouldReplay = mode === "replay" && position < replayTurns;

    if (shouldReplay) {
      const expected = cassette.turns[position];
      if (!expected) {
        throw new CassetteDivergenceError({
          cassette: cassette.name,
          turn: position,
          expectedFingerprint: "<end-of-cassette>",
          actualFingerprint,
          expected: emptyRequest(),
          actual: normalizedRequest,
          diff: structuredDiff(emptyRequest(), normalizedRequest),
        });
      }
      if (expected.fingerprint !== actualFingerprint) {
        throw new CassetteDivergenceError({
          cassette: cassette.name,
          turn: position,
          expectedFingerprint: expected.fingerprint,
          actualFingerprint,
          expected: expected.request,
          actual: normalizedRequest,
          diff: structuredDiff(expected.request, normalizedRequest),
        });
      }
      position += 1;
      if (options.onReplay) {
        await options.onReplay({ cassette: cassette.name, turn: expected.index, response: structuredClone(expected.response) });
      }
      return options.adapter.replayResponse(structuredClone(expected.response));
    }

    const client = options.client;
    if (!client) {
      const reason = mode === "record" ? "record mode" : `partial replay after turn ${replayTurns}`;
      throw new Error(`A real client boundary is required for ${reason}.`);
    }
    const liveResponse = await client(input);
    const normalizedResponse = withCalculatedCost(
      redacted(options.adapter.normalizeResponse(liveResponse), options.redaction),
      normalizedRequest,
      options.calculateCost,
    );

    if (mode === "record") {
      const now = new Date().toISOString();
      cassette.turns.push({
        index: position,
        fingerprint: actualFingerprint,
        request: normalizedRequest,
        events: eventsForTurn(normalizedRequest, normalizedResponse),
        response: normalizedResponse,
      });
      cassette.updatedAt = now;
      await store.write(cassette);
    }
    position += 1;
    return liveResponse;
  };

  const wrapped = ((input: Request): Promise<Response> => {
    const result = queue.then(() => invoke(input));
    queue = result.then(() => undefined, () => undefined);
    return result;
  }) as CassetteClient<Request, Response>;

  Object.defineProperties(wrapped, {
    cassetteName: { value: options.name, enumerable: true },
    mode: { value: mode, enumerable: true },
    turn: { get: () => position, enumerable: true },
  });
  return wrapped;
}

function validateOptions<Request, Response>(options: CassetteClientOptions<Request, Response>): void {
  if (!options.name.trim()) throw new Error("Cassette name cannot be empty.");
  if (options.replayTurns !== undefined && (!Number.isInteger(options.replayTurns) || options.replayTurns < 0)) {
    throw new Error("replayTurns must be a non-negative integer.");
  }
}

function redacted<T>(value: T, options: RedactionOptions | undefined): T {
  return redact(value, options ?? {});
}

function withCalculatedCost(
  response: SemanticResponse,
  request: SemanticRequest,
  calculator: CostCalculator | undefined,
): SemanticResponse {
  if (!calculator) return response;
  const cost = calculator({ request, response });
  if (cost === undefined) return response;
  if (!Number.isFinite(cost) || cost < 0) throw new Error("calculateCost must return a non-negative finite number or undefined.");
  const usage = response.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  return { ...response, usage: { ...usage, costUsd: cost } };
}

function newCassette(
  name: string,
  provider: string,
  metadata: CassetteMetadata | undefined,
  usesDefaultFingerprint: boolean,
): Cassette {
  const now = new Date().toISOString();
  const mergedMetadata: CassetteMetadata = {
    ...metadata,
    provider,
    fingerprint: usesDefaultFingerprint ? "default" : "custom",
  };
  return {
    schemaVersion: 1,
    name,
    createdAt: now,
    updatedAt: now,
    turns: [],
    metadata: mergedMetadata,
  };
}

function emptyRequest(): SemanticRequest {
  return { messages: [], tools: [] };
}
