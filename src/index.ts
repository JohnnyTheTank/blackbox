#!/usr/bin/env -S npx tsx
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const INSTALL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(INSTALL_DIR, ".env");
if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // ignore malformed .env
  }
}

const STATE_PATH = join(INSTALL_DIR, ".blackbox-state.json");

type PersistedState = {
  model?: string;
};

function readPersistedState(): PersistedState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as PersistedState;
    }
    return {};
  } catch {
    return {};
  }
}

function writePersistedState(state: PersistedState): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // persistence is best-effort; ignore write failures
  }
}

function persistModel(model: string): void {
  const state = readPersistedState();
  if (state.model === model) return;
  state.model = model;
  writePersistedState(state);
}

import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import {
  runAgent,
  buildInitialHistory,
  type AgentReporter,
  type ToolCallRecord,
  type UserContent,
} from "./agent.ts";
import {
  CURATED_MODELS,
  DEFAULT_MODEL,
  OPENROUTER_API_KEY_ENV,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  TOOL_LIST_ARG_PREVIEW_MAX,
  TOOL_PREVIEW_MAX_CHARS,
  TOOL_PREVIEW_MAX_LINES,
  VISION_HINTS,
  WORKSPACE_ROOT,
} from "./config.ts";
import {
  parseImages,
  dumpClipboardImage,
  formatBytes,
  type ParsedImage,
} from "./images.ts";

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
  const persisted = readPersistedState().model;
  if (persisted && persisted.length > 0) return persisted;
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

type Spinner = {
  start: (label?: string) => void;
  stop: () => void;
  log: (line: string) => void;
};

function createSpinner(): Spinner {
  const isTTY = Boolean(process.stdout.isTTY);
  let timer: NodeJS.Timeout | null = null;
  let frame = 0;
  let label = "working…";

  const clearLine = (): void => {
    if (!isTTY) return;
    process.stdout.write("\r\x1b[2K");
  };

  const render = (): void => {
    if (!isTTY) return;
    const f = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    process.stdout.write(`\r\x1b[2K\x1b[2m${f} ${label}\x1b[0m`);
  };

  return {
    start(next?: string) {
      if (!isTTY || timer) return;
      if (next) label = next;
      frame = 0;
      render();
      timer = setInterval(() => {
        frame += 1;
        render();
      }, SPINNER_INTERVAL_MS);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      clearLine();
    },
    log(line: string) {
      clearLine();
      process.stdout.write(`${line}\n`);
      if (timer) render();
    },
  };
}

function previewResult(result: string): string {
  const maxLines = TOOL_PREVIEW_MAX_LINES;
  const maxChars = TOOL_PREVIEW_MAX_CHARS;
  const trimmed = result.replace(/\s+$/u, "");
  const lines = trimmed.split("\n");
  const selected = lines.slice(0, maxLines).join("\n");
  const truncatedLines = lines.length > maxLines;
  const truncatedChars = selected.length > maxChars;
  const body = truncatedChars ? `${selected.slice(0, maxChars)}…` : selected;
  return truncatedLines && !truncatedChars ? `${body}\n…` : body;
}

function formatToolCallLine(name: string, args: string): string {
  return C.dim(`  → ${name}(${args})`);
}

function formatToolPreviewBlock(result: string): string {
  const preview = previewResult(result);
  if (preview.length === 0) return C.dim("    (empty result)");
  return preview
    .split("\n")
    .map((line) => C.dim(`    ${line}`))
    .join("\n");
}

function printTools(calls: ToolCallRecord[]): void {
  console.log("");
  if (calls.length === 0) {
    console.log(C.dim("No tool calls in the last run."));
    console.log("");
    return;
  }
  console.log(C.bold(`Tool calls from last run (${calls.length}):`));
  calls.forEach((call, idx) => {
    const size = call.result.length;
    console.log(
      `  ${idx + 1}. ${call.name}(${shortenArgs(call.args)}) ${C.dim(
        `→ ${size} chars`,
      )}`,
    );
  });
  console.log(C.dim("\n  Use /tool <n> to see full args and result."));
  console.log("");
}

function shortenArgs(raw: string): string {
  const max = TOOL_LIST_ARG_PREVIEW_MAX;
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function prettyJson(raw: string): string {
  if (raw.trim().length === 0) return "(no args)";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function printToolDetail(calls: ToolCallRecord[], indexArg: string): void {
  const n = Number.parseInt(indexArg, 10);
  if (!Number.isInteger(n) || n < 1 || n > calls.length) {
    console.log(
      C.red(
        `  /tool: expected an index between 1 and ${calls.length || 0}, got "${indexArg}".`,
      ),
    );
    return;
  }
  const call = calls[n - 1]!;
  console.log("");
  console.log(C.bold(`Tool call #${n}: ${call.name}`));
  console.log(C.dim("  args:"));
  console.log(
    prettyJson(call.args)
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );
  console.log(C.dim("  result:"));
  console.log(
    call.result
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );
  console.log("");
}

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
      "  /tools           List tool calls from the last agent run",
      "  /tool <n>        Show full args and result for tool call #n",
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
  persistModel(model);
  let history = buildInitialHistory();
  let lastToolCalls: ToolCallRecord[] = [];
  const spinner = createSpinner();

  console.log(C.bold(C.cyan("blackbox") + " — minimal CLI coding agent"));
  console.log(C.dim(`  Workspace: ${WORKSPACE_ROOT}`));
  console.log(C.dim(`  Model:     ${model}`));
  console.log(
    C.dim("  Tip: /help for commands, Ctrl-C cancels a run or exits when idle."),
  );
  console.log("");

  if (!process.env[OPENROUTER_API_KEY_ENV]) {
    console.log(
      C.yellow(
        `Warning: ${OPENROUTER_API_KEY_ENV} is not set. Please create a .env file (see .env.example).`,
      ),
    );
    console.log("");
  }

  const rl = readline.createInterface({ input, output });

  let currentAbort: AbortController | null = null;
  let pendingExitConfirm = false;
  let exitConfirmTimer: NodeJS.Timeout | null = null;

  const clearExitConfirm = (): void => {
    pendingExitConfirm = false;
    if (exitConfirmTimer) {
      clearTimeout(exitConfirmTimer);
      exitConfirmTimer = null;
    }
  };

  rl.on("SIGINT", () => {
    if (currentAbort && !currentAbort.signal.aborted) {
      currentAbort.abort();
      spinner.log(C.yellow("  ^C — cancelling…"));
      clearExitConfirm();
      return;
    }
    if (pendingExitConfirm) {
      console.log("\n" + C.dim("Bye."));
      rl.close();
      process.exit(0);
    }
    pendingExitConfirm = true;
    exitConfirmTimer = setTimeout(() => {
      pendingExitConfirm = false;
      exitConfirmTimer = null;
    }, 2000);
    process.stdout.write(
      "\r\x1b[2K" +
      C.yellow("Press Ctrl-C again within 2s to exit.") +
      "\n" +
      C.bold("> "),
    );
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
      lastToolCalls = [];
      console.log(C.dim("History cleared."));
      continue;
    }

    if (entry === "/tools") {
      printTools(lastToolCalls);
      continue;
    }

    if (entry.startsWith("/tool ") || entry === "/tool") {
      const rest = entry === "/tool" ? "" : entry.slice("/tool ".length).trim();
      if (rest.length === 0) {
        console.log(
          C.red("  /tool requires an index, e.g. /tool 2. Use /tools to list."),
        );
      } else {
        printToolDetail(lastToolCalls, rest);
      }
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
        persistModel(model);
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

    const reporter: AgentReporter = {
      onToolCall: (name, args) => {
        spinner.log(formatToolCallLine(name, args));
      },
      onToolResult: (_name, result) => {
        spinner.log(formatToolPreviewBlock(result));
      },
    };

    const abort = new AbortController();
    currentAbort = abort;
    const historyBefore = history.length;
    clearExitConfirm();

    spinner.start("working…");
    try {
      const { answer, toolCalls } = await runAgent(
        history,
        userContent,
        model,
        reporter,
        abort.signal,
      );
      spinner.stop();
      lastToolCalls = toolCalls;
      console.log("");
      console.log(answer && answer.length > 0 ? answer : C.dim("(empty response)"));
      if (toolCalls.length > 0) {
        console.log(
          C.dim(
            `\n  (${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"
            } — /tools to list, /tool <n> for details)`,
          ),
        );
      }
      console.log("");
    } catch (err) {
      spinner.stop();
      if (abort.signal.aborted) {
        history.length = historyBefore;
        console.log("");
        console.log(C.yellow("Cancelled.") + "\n");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(C.red(`\nError: ${msg}\n`));
      }
    } finally {
      currentAbort = null;
      clearExitConfirm();
    }
  }

  rl.close();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`Fatal error: ${msg}`);
  process.exit(1);
});
