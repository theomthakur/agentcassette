import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { defaultFingerprint } from "../core/fingerprint.js";
import { FileCassetteStore } from "../core/storage.js";
import type { Cassette } from "../core/types.js";
import { readUsageEvents } from "../adapters/usage-reader.js";

interface CliContext {
  directory: string;
  usageFile: string;
  cwd: string;
}

export async function runCli(argv: string[]): Promise<number> {
  const delimiter = argv.indexOf("--");
  const command = delimiter >= 0 ? argv.slice(delimiter + 1) : [];
  const ownArgs = delimiter >= 0 ? argv.slice(0, delimiter) : argv;
  const directory = optionValue(ownArgs, "--dir") ?? process.env.AGENTCASSETTE_DIR ?? ".agentcassette/cassettes";
  const context: CliContext = {
    directory,
    usageFile: process.env.AGENTCASSETTE_USAGE_FILE ?? join(dirname(directory), "usage.ndjson"),
    cwd: process.cwd(),
  };
  const positional = ownArgs.filter((argument, index) => argument !== "--yes" && argument !== "--json" && argument !== "--dir" && ownArgs[index - 1] !== "--dir");
  const action = positional[0] ?? "help";

  if (action === "list") return listCassettes(context, ownArgs.includes("--json"));
  if (action === "stats") return showStats(context, ownArgs.includes("--json"));
  if (action === "prune") return pruneCassettes(context, ownArgs.includes("--yes"), optionValues(ownArgs, "--name"));
  if (action === "verify") return verifyCassettes(context, command);
  if (action === "help" || action === "--help" || action === "-h") {
    printHelp();
    return 0;
  }
  console.error(`Unknown command: ${action}`);
  printHelp();
  return 1;
}

async function listCassettes(context: CliContext, json: boolean): Promise<number> {
  const store = new FileCassetteStore(context.directory);
  const cassettes = await readAll(store);
  if (json) {
    console.log(JSON.stringify(cassettes.map(summary), null, 2));
    return 0;
  }
  if (cassettes.length === 0) {
    console.log("No cassettes found.");
    return 0;
  }
  console.log("NAME\tTURNS\tPROVIDER\tUPDATED");
  for (const cassette of cassettes) {
    console.log(`${cassette.name}\t${cassette.turns.length}\t${cassette.metadata?.provider ?? "unknown"}\t${cassette.updatedAt}`);
  }
  return 0;
}

async function showStats(context: CliContext, json: boolean): Promise<number> {
  const store = new FileCassetteStore(context.directory);
  const cassettes = await readAll(store);
  const events = await readUsageEvents(context.usageFile);
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let recordedCostUsd = 0;
  for (const cassette of cassettes) {
    turns += cassette.turns.length;
    for (const turn of cassette.turns) {
      inputTokens += turn.response.usage?.inputTokens ?? 0;
      outputTokens += turn.response.usage?.outputTokens ?? 0;
      recordedCostUsd += turn.response.usage?.costUsd ?? 0;
    }
  }
  const replayEvents = events.filter((event) => event.type === "replay");
  const stats = {
    cassettes: cassettes.length,
    recordedTurns: turns,
    recordedInputTokens: inputTokens,
    recordedOutputTokens: outputTokens,
    recordedCostUsd,
    replayedTurns: replayEvents.length,
    moneySavedUsd: replayEvents.reduce((total, event) => total + (event.costSavedUsd ?? 0), 0),
  };
  if (json) console.log(JSON.stringify(stats, null, 2));
  else {
    console.log(`Cassettes: ${stats.cassettes}`);
    console.log(`Recorded turns: ${stats.recordedTurns}`);
    console.log(`Recorded tokens: ${stats.recordedInputTokens + stats.recordedOutputTokens} (${stats.recordedInputTokens} input, ${stats.recordedOutputTokens} output)`);
    console.log(`Replayed turns: ${stats.replayedTurns}`);
    console.log(`Recorded API cost: $${stats.recordedCostUsd.toFixed(4)}`);
    console.log(`Money saved by tracked replays: $${stats.moneySavedUsd.toFixed(4)}`);
  }
  return 0;
}

async function pruneCassettes(context: CliContext, confirmed: boolean, selected: string[]): Promise<number> {
  const store = new FileCassetteStore(context.directory);
  const names = await store.list();
  const references = await sourceReferences(context.cwd, names);
  const usage = await readUsageEvents(context.usageFile);
  const observed = new Set(usage.filter((event) => event.type === "use").map((event) => event.cassette));
  const unused = names.filter((name) => !references.has(name) && !observed.has(name));
  if (unused.length === 0) {
    console.log("No unused cassettes found.");
    return 0;
  }
  if (!confirmed) {
    console.log(`Would prune ${unused.length} unused cassette(s): ${unused.join(", ")}`);
    console.log("Delete reviewed candidates with --yes and one --name <cassette> per cassette.");
    return 0;
  }
  if (selected.length === 0) {
    console.error("Refusing heuristic deletion. Add --name <cassette> for each reviewed candidate.");
    return 1;
  }
  const rejected = selected.filter((name) => !unused.includes(name));
  if (rejected.length > 0) {
    console.error(`Refusing to prune cassette(s) that are not unused candidates: ${rejected.join(", ")}`);
    return 1;
  }
  for (const name of selected) await store.remove(name);
  console.log(`Pruned ${selected.length} unused cassette(s): ${selected.join(", ")}`);
  return 0;
}

async function verifyCassettes(context: CliContext, command: string[]): Promise<number> {
  const store = new FileCassetteStore(context.directory);
  const cassettes = await readAll(store);
  const failures: string[] = [];
  for (const cassette of cassettes) {
    for (const [index, turn] of cassette.turns.entries()) {
      if (turn.index !== index) failures.push(`${cassette.name}: turn ${index + 1} has index ${turn.index}`);
      if (cassette.metadata?.fingerprint !== "custom") {
        const actual = defaultFingerprint(turn.request);
        if (actual !== turn.fingerprint) failures.push(`${cassette.name}: turn ${index + 1} fingerprint is stale`);
      }
    }
  }
  const references = await sourceReferences(context.cwd, cassettes.map((cassette) => cassette.name));
  const usage = await readUsageEvents(context.usageFile);
  const observed = new Set(usage.filter((event) => event.type === "use").map((event) => event.cassette));
  for (const cassette of cassettes) {
    if (!references.has(cassette.name) && !observed.has(cassette.name)) {
      failures.push(`${cassette.name}: no test/source reference or runtime usage found`);
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    return 1;
  }
  if (command.length > 0) {
    const exitCode = await runCommand(command, context);
    if (exitCode !== 0) return exitCode;
  }
  console.log(`Verified ${cassettes.length} cassette(s)${command.length > 0 ? " against the test command" : " structurally"}.`);
  return 0;
}

async function runCommand(command: string[], context: CliContext): Promise<number> {
  const executable = command[0];
  if (!executable) return 0;
  return new Promise((resolveExit, reject) => {
    const child = spawn(executable, command.slice(1), {
      cwd: context.cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        AGENTCASSETTE_MODE: "replay",
        AGENTCASSETTE_DIR: context.directory,
        AGENTCASSETTE_USAGE_FILE: context.usageFile,
      },
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}

async function readAll(store: FileCassetteStore): Promise<Cassette[]> {
  const names = await store.list();
  return Promise.all(names.map((name) => store.read(name)));
}

function summary(cassette: Cassette): object {
  return {
    name: cassette.name,
    turns: cassette.turns.length,
    provider: cassette.metadata?.provider ?? null,
    updatedAt: cassette.updatedAt,
  };
}

async function sourceReferences(cwd: string, names: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (names.length === 0) return found;
  const files = await sourceFiles(cwd);
  await Promise.all(files.map(async (file) => {
    const source = await readFile(file, "utf8");
    for (const name of names) if (source.includes(name)) found.add(name);
  }));
  return found;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === ".agentcassette") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) result.push(path);
  }
  return result;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function optionValues(args: string[], name: string): string[] {
  return args.flatMap((argument, index) => argument === name && args[index + 1] !== undefined ? [args[index + 1] as string] : []);
}

function printHelp(): void {
  console.log(`agentcassette <command> [options]\n\nCommands:\n  list [--json]               List cassettes\n  stats [--json]              Show recorded usage and tracked savings\n  prune [--yes --name <id>]   Find unused cassettes; delete reviewed names\n  verify [-- <test command>]  Validate cassettes; optionally replay all tests\n\nOptions:\n  --dir <path>                Cassette directory (default: .agentcassette/cassettes)`);
}
