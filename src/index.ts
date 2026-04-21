#!/usr/bin/env -S npx tsx
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { runAgent, buildInitialHistory } from "./agent.ts";
import { WORKSPACE_ROOT } from "./sandbox.ts";

const DEFAULT_MODEL = "google/gemini-3-flash-preview";

const CURATED_MODELS = [
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-opus-4.1",
  "openai/gpt-5",
  "openai/gpt-4.1",
  "google/gemini-3-flash-preview",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "x-ai/grok-4",
  "deepseek/deepseek-chat",
];

function parseModelFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model" || arg === "-m") {
      return argv[i + 1];
    }
    if (arg && arg.startsWith("--model=")) {
      return arg.slice("--model=".length);
    }
  }
  return undefined;
}

function resolveInitialModel(): string {
  const fromFlag = parseModelFlag(process.argv.slice(2));
  if (fromFlag && fromFlag.length > 0) return fromFlag;
  return DEFAULT_MODEL;
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

function printHelp(): void {
  console.log(
    [
      "",
      C.bold("Commands:"),
      "  /help            Show this help",
      "  /model           Show the current model",
      "  /model <slug>    Switch model (e.g. /model openai/gpt-5)",
      "  /models          Curated list of common tool-capable models",
      "  /reset           Clear the chat history",
      "  /exit, exit      Quit (also Ctrl-C)",
      "",
    ].join("\n"),
  );
}

function printModels(current: string): void {
  console.log("");
  console.log(C.bold("Curated models (tool-calling capable):"));
  for (const m of CURATED_MODELS) {
    const marker = m === current ? C.green(" ← current") : "";
    console.log(`  ${m}${marker}`);
  }
  console.log(
    C.dim(
      "\n  Full list: https://openrouter.ai/models?supported_parameters=tools",
    ),
  );
  console.log("");
}

async function main(): Promise<void> {
  let model = resolveInitialModel();
  let history = buildInitialHistory();

  console.log(C.bold(C.cyan("blackbox") + " — minimal CLI coding agent"));
  console.log(C.dim(`  Workspace: ${WORKSPACE_ROOT}`));
  console.log(C.dim(`  Model:     ${model}`));
  console.log(C.dim("  Tip: /help for commands, Ctrl-C to quit."));
  console.log("");

  if (!process.env.OPENROUTER_API_KEY) {
    console.log(
      C.yellow(
        "Warning: OPENROUTER_API_KEY is not set. Please create a .env file (see .env.example).",
      ),
    );
    console.log("");
  }

  const rl = readline.createInterface({ input, output });
  rl.on("SIGINT", () => {
    console.log("\n" + C.dim("Bye."));
    rl.close();
    process.exit(0);
  });

  while (true) {
    let line: string;
    try {
      line = await rl.question(C.bold("> "));
    } catch {
      break;
    }

    const entry = line.trim();
    if (entry.length === 0) continue;

    if (entry === "exit" || entry === "/exit" || entry === "quit") {
      break;
    }

    if (entry === "/help") {
      printHelp();
      continue;
    }

    if (entry === "/reset") {
      history = buildInitialHistory();
      console.log(C.dim("History cleared."));
      continue;
    }

    if (entry === "/models") {
      printModels(model);
      continue;
    }

    if (entry === "/model") {
      console.log(C.dim(`Current model: ${model}`));
      continue;
    }

    if (entry.startsWith("/model ")) {
      const newModel = entry.slice("/model ".length).trim();
      if (newModel.length === 0) {
        console.log(C.red("Please provide a model slug."));
      } else {
        model = newModel;
        console.log(C.green(`Switched model to: ${model}`));
      }
      continue;
    }

    if (entry.startsWith("/")) {
      console.log(
        C.red(`Unknown command: ${entry}. Use /help to see the list.`),
      );
      continue;
    }

    try {
      const answer = await runAgent(history, entry, model);
      console.log("");
      console.log(answer && answer.length > 0 ? answer : C.dim("(empty response)"));
      console.log("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(C.red(`\nError: ${msg}\n`));
    }
  }

  rl.close();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`Fatal error: ${msg}`);
  process.exit(1);
});
