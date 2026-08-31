# agentcassette

[![CI](https://github.com/theomthakur/agentcassette/actions/workflows/ci.yml/badge.svg)](https://github.com/theomthakur/agentcassette/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agentcassette)](https://www.npmjs.com/package/agentcassette)
[![install size](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Record an LLM agent run once. Replay it in CI with zero API calls and zero non-determinism.**

```bash
npm install --save-dev agentcassette
```

Recording happens at the **semantic layer**, not the HTTP layer: messages, tool calls with their
arguments, tool results and final output, normalized across OpenAI, Anthropic, Google and
OpenAI-compatible shapes. A cassette therefore survives an SDK upgrade or a provider swap, which
is exactly where HTTP-level recorders like Polly and nock break.

Zero runtime dependencies.

## When a replay diverges, it tells you why

Matching uses a configurable request fingerprint rather than byte equality, so prompts can change
without invalidating every cassette. When a request genuinely no longer matches, you get this
instead of a bare failure:

```
Agent cassette diverged at turn 1 in "trip-planner".
Expected fingerprint: sha256:4a462fea...
Actual fingerprint:   sha256:6e2ebeae...

Structured request diff:
  $.messages[0].content[0].text (changed)
    expected: "capital of France?"
    actual:   "capital of Germany?"

Fix the changed request, re-record this cassette intentionally, or provide a custom
fingerprint when the change is non-behavioral.
```

You fix it from the message without opening the cassette.

---

Deterministic, semantic record and replay for LLM agent tests. Run agent tests in CI with **zero API calls** and no provider-shaped fixture code.

## Before and after

Before, every test calls the provider and can fail because the model changed:

```ts
const result = await openai.chat.completions.create(request);
expect(result.choices[0].message.content).toContain("Paris");
```

After, wrap that same client boundary once. The first run records; every later run replays:

```ts
import { openAI } from "agentcassette";
import { withVitestCassette } from "agentcassette/vitest";

type Request = Parameters<typeof openai.chat.completions.create>[0];
type Response = Awaited<ReturnType<typeof openai.chat.completions.create>>;

const chat = await withVitestCassette<Request, Response>({
  name: "trip-planner",
  client: (request) => openai.chat.completions.create(request),
  adapter: openAI<Request, Response>(),
});

const result = await chat(request);
expect(result.choices[0].message.content).toContain("Paris");
```

No mode switch is needed. `auto` (the default) replays when `.agentcassette/cassettes/trip-planner.json` exists and records when it does not. Cassette names must be lowercase and may contain digits, dots, underscores, and hyphens; unsafe or ambiguous filesystem names are rejected.

## Why semantic recording

HTTP cassettes capture URLs, headers, streaming frames, and SDK serialization details. They break when a provider or SDK changes even if the agent makes the same decisions. agentcassette records the provider-independent behavior instead:

1. messages sent;
2. tool calls proposed, including normalized arguments;
3. tool results returned;
4. final output and token/cost usage.

Built-in adapters normalize OpenAI, OpenAI-compatible APIs, Anthropic, and Google into the same format. Cassettes are formatted JSON intended to be read and reviewed in pull requests.

## Install

```sh
npm install --save-dev agentcassette
```

Node.js 18.18 or newer is required. The package has zero runtime dependencies and ships ESM and CommonJS builds.

## Modes

```ts
const chat = await createCassetteClient({
  name: "trip-planner",
  mode: "record", // "record" | "replay" | "auto"
  client: callProvider,
  adapter: openAI(),
});
```

- `record` calls the real boundary and writes each completed turn atomically.
- `replay` serves normalized responses from the cassette. The real boundary is never called for replayed turns and may be omitted.
- `auto` replays an existing cassette or records a new one.

Calls through one wrapper are serialized so concurrent application code cannot make cassette order nondeterministic.

## Matching and divergence

The default request fingerprint includes:

- tool names and normalized input schemas;
- conversation role/content-part structure;
- normalized prior user turns, assistant decisions, and tool results;
- normalized semantic text of the final user turn.

It ignores model names, system-prompt text, whitespace changes, and timestamps. Replace it when your agent has different behavioral boundaries:

```ts
const chat = await createCassetteClient({
  name: "router",
  mode: "replay",
  adapter: anthropic(),
  fingerprint: (request) => `route:${request.tools.map((tool) => tool.name).join(",")}`,
});
```

A mismatch throws `CassetteDivergenceError`. Its message includes the one-based divergent turn, expected and actual fingerprints, path-level additions/removals/changes, expected and actual values, and remediation. The same structured data is available on `error.report`.

## Partial replay

Replay a known-good prefix, then debug the live tail:

```ts
const chat = await createCassetteClient({
  name: "long-agent-run",
  mode: "replay",
  replayTurns: 12,
  client: callProvider,
  adapter: anthropic(),
});
```

Turns 1–12 make zero network calls. Turn 13 onward uses `client`; tail requests are intentionally not matched against or written to the cassette.

## Redaction

Common secret keys, bearer tokens, email addresses, and phone numbers are redacted before writing. Add domain-specific rules:

```ts
const chat = await createCassetteClient({
  name: "support-agent",
  mode: "record",
  client: callProvider,
  adapter: google(),
  redaction: {
    rules: [{
      name: "customer-id",
      match: ({ key }) => key === "customerId",
      replacement: "[CUSTOMER]",
    }],
  },
});
```

Redaction happens before fingerprinting, so replay and `verify` remain consistent without retaining the original sensitive value. Review custom rules carefully: a cassette is still source-controlled test data.

## Provider adapters

```ts
import { openAI, openAICompatible, anthropic, google, semantic } from "agentcassette";
```

Each adapter accepts request/response generics and synthesizes a plain provider-shaped data object during replay, including normalized IDs, model, content, tool calls, finish reason, and usage when recorded. SDK class methods and non-semantic transport metadata are intentionally not reproduced; use a custom `ProviderAdapter<Request, Response>` when application code depends on them. `semantic()` is useful for a custom boundary that already uses `SemanticRequest` and `SemanticResponse`.

## Vitest and Jest

Both adapters use the same one-wrapper-call API and do not import their test runner at runtime:

```ts
import { withVitestCassette } from "agentcassette/vitest";
// import { withJestCassette } from "agentcassette/jest";

const agent = await withVitestCassette({
  name: "tool-agent",
  client: runAgentTurn,
  adapter: semantic(),
  testFile: import.meta.filename,
});
```

Set `AGENTCASSETTE_MODE=record|replay|auto` to override mode for a whole test run. `AGENTCASSETTE_DIR` changes the cassette directory.

## CLI

```sh
npx agentcassette list
npx agentcassette stats
npx agentcassette verify -- npm test
npx agentcassette prune                                      # dry run
npx agentcassette prune --yes --name old-agent-cassette     # delete one reviewed candidate
```

`verify` validates complete cassette structure, indexes, and fingerprints and checks source references or observed test-runner usage. With a command after `--`, it runs that command with replay forced, so divergence or missing cassettes fail CI. `prune` uses source references and locally tracked runtime usage only to propose candidates; deletion requires `--yes` plus an explicit `--name` for every reviewed cassette, so heuristics never authorize deletion. `stats` reports recorded tokens/cost and savings from replays performed through the Vitest/Jest adapters.

Providers generally report tokens but not dollar cost. Store cost with `calculateCost`:

```ts
calculateCost: ({ response }) => {
  const usage = response.usage;
  return usage ? usage.inputTokens * 0.000001 + usage.outputTokens * 0.000002 : undefined;
},
```

Use prices appropriate to your provider and model; agentcassette deliberately does not ship a changing pricing table.

## Cassette format

```json
{
  "schemaVersion": 1,
  "name": "trip-planner",
  "turns": [{
    "index": 0,
    "fingerprint": "sha256:…",
    "request": { "messages": [], "tools": [] },
    "events": [
      { "type": "messages.sent", "messages": [] },
      { "type": "output.final", "content": [{ "type": "text", "text": "…" }] }
    ],
    "response": { "content": [], "toolCalls": [] }
  }]
}
```

The complete request and response are retained in normalized form so divergence reports are self-contained. No raw HTTP payload, authorization header, provider URL, or SDK object is recorded.

## Scope

agentcassette records and replays deterministic agent behavior. It does not evaluate, score, grade, trace, host, or visualize agent runs.

## License

MIT


---

Sibling project: [benchtrace](https://github.com/theomthakur/benchtrace), trace-first evaluation for LLM agents.

Built by Om Thakur ·
[portfolio](https://theomthakur.github.io/portfolio) ·
[github](https://github.com/theomthakur) ·
[linkedin](https://linkedin.com/in/theomthakur)
