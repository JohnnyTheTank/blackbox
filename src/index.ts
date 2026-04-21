#!/usr/bin/env -S npx tsx
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const INSTALL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(INSTALL_DIR, ".env");
if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // ignore malformed .env
  }
}

import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { runAgent, buildInitialHistory, type UserContent } from "./agent.ts";
import { WORKSPACE_ROOT } from "./sandbox.ts";
import {
  parseImages,
  dumpClipboardImage,
  formatBytes,
  type ParsedImage,
} from "./images.ts";

const DEFAULT_MODEL = "openrouter/elephant-alpha";

const CURATED_MODELS = [
  "openrouter/elephant-alpha",
  "z-ai/glm-4.5-air:free",
  "anthropic/claude-sonnet-4.5",
  "google/gemini-3-flash-preview",
  "nvidia/nemotron-3-super-120b-a12b:free",
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
      "  /paste [text]    Attach the macOS clipboard image, optionally with text",
      "  /reset           Clear the chat history",
      "  /exit, exit      Quit (also Ctrl-C)",
      "",
      C.dim(
        "  Tip: just include an image path or http(s) URL in your prompt —",
      ),
      C.dim(
        "       .png/.jpg/.jpeg/.gif/.webp are auto-attached.",
      ),
      "",
    ].join("\n"),
  );
}

const VISION_HINTS = [
  /claude/i,
  /gemini/i,
  /gpt-4/i,
  /gpt-5/i,
  /grok.*vision/i,
  /qwen.*vl/i,
  /llama.*vision/i,
  /pixtral/i,
  /mistral.*pixtral/i,
  /internvl/i,
];

function looksVisionCapable(model: string): boolean {
  return VISION_HINTS.some((re) => re.test(model));
}

function logAttachments(images: ParsedImage[]): void {
  for (const img of images) {
    const size = img.bytes !== undefined ? ` (${formatBytes(img.bytes)})` : "";
    console.log(C.dim(`  attached: ${img.displayName}${size}`));
  }
}

function buildUserContent(text: string, images: ParsedImage[]): UserContent {
  if (images.length === 0) return text;
  const parts: ChatCompletionContentPart[] = [];
  if (text.length > 0) {
    parts.push({ type: "text", text });
  }
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: img.url } });
  }
  return parts;
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

    let pasteText: string | undefined;
    if (entry === "/paste" || entry.startsWith("/paste ")) {
      let clipPath: string;
      try {
        clipPath = dumpClipboardImage();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(C.red(`/paste failed: ${msg}`));
        continue;
      }
      const rest = entry === "/paste" ? "" : entry.slice("/paste ".length).trim();
      pasteText = rest.length > 0 ? `${clipPath} ${rest}` : clipPath;
    } else if (entry.startsWith("/")) {
      console.log(
        C.red(`Unknown command: ${entry}. Use /help to see the list.`),
      );
      continue;
    }

    const promptSource = pasteText ?? entry;
    const { text, images, warnings } = parseImages(promptSource);

    for (const w of warnings) {
      console.log(C.yellow(`  ${w}`));
    }

    if (images.length > 0) {
      logAttachments(images);
      if (!looksVisionCapable(model)) {
        console.log(
          C.yellow(
            `  warning: model "${model}" may not support images; sending anyway.`,
          ),
        );
      }
    }

    const finalText = text.length > 0 ? text : images.length > 0 ? "" : promptSource;
    if (images.length === 0 && finalText.length === 0) continue;

    const userContent = buildUserContent(finalText, images);

    try {
      const answer = await runAgent(history, userContent, model);
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
