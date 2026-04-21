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
  type AskUserHandler,
  type AskUserRequest,
  type RunAgentOptions,
  type ToolCallRecord,
  type UserContent,
} from "./agent.ts";
import {
  CURATED_MODELS,
  DEFAULT_MODEL,
  OPENROUTER_API_KEY_ENV,
  PLAN_DONE_SUFFIX,
  PLAN_FILE_SUFFIX,
  PLAN_SYSTEM_PROMPT,
  PLANS_DIR,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  SYSTEM_PROMPT,
  TOOL_LIST_ARG_PREVIEW_MAX,
  TOOL_PREVIEW_MAX_CHARS,
  TOOL_PREVIEW_MAX_LINES,
  VISION_HINTS,
  WORKSPACE_ROOT,
} from "./config.ts";
import {
  AGENT_TOOL_SCHEMAS,
  PLAN_TOOL_SCHEMAS,
  sanitizePlanSlug,
  setSubagentFallbackModel,
} from "./tools.ts";
import {
  parseImages,
  dumpClipboardImage,
  formatBytes,
  type ParsedImage,
} from "./images.ts";
import {
  selectFromList,
  selectFromListEx,
  type SelectOption,
} from "./select.ts";
import {
  countRunning,
  formatRuntime,
  killAll,
  killJob,
  listJobs,
  readJobLog,
  type JobSummary,
} from "./jobs.ts";
import {
  AGENTS_DIRS,
  getAgentRegistry,
  listAgents,
} from "./subagents.ts";
import {
  formatRefsBlock,
  invalidateCache as invalidateRefsCache,
  resolveRefs,
  scanWorkspace,
} from "./refs.ts";
import { pickPath } from "./pickPath.ts";

type Mode = "agent" | "plan";

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

type InitialModelResolution = {
  model: string;
  source: "flag" | "persisted" | "default";
};

function resolveInitialModel(): InitialModelResolution {
  const fromFlag = parseModelFlag(process.argv.slice(2));
  if (fromFlag && fromFlag.length > 0) {
    return { model: fromFlag, source: "flag" };
  }
  const persisted = readPersistedState().model;
  if (persisted && persisted.length > 0) {
    return { model: persisted, source: "persisted" };
  }
  return { model: DEFAULT_MODEL, source: "default" };
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
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
  console.log(
    C.dim(
      "\n  Use /tool for an interactive picker, or /tool <n> for details.",
    ),
  );
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
      "  /help                Show this help",
      "  /model               Show the current model",
      "  /model <slug>        Switch model directly (e.g. /model openai/gpt-5.4)",
      "  /models              Interactive model picker (↑↓ + Enter)",
      "  /paste [text]        Attach the macOS clipboard image, optionally with text",
      "  /tools               List tool calls from the last agent run",
      "  /tool                Interactive tool-call picker (↑↓ + Enter)",
      "  /tool <n>            Show full args and result for tool call #n",
      "  /plan                Switch to plan mode (read-only, writes .blackbox/plans/*.plan.md)",
      "  /agent               Switch back to agent mode (default, can edit files)",
      "  /plans               Pick an open plan → View / Refine / Execute",
      "  /plans all           Same as /plans, but includes done plans",
      "  /plan done <slug>    Mark a plan as done (renames to .plan.done.md)",
      "  /jobs                List jobs; Enter = log, Del/Backspace = kill selected",
      "  /jobs kill <id>      Kill a running job (SIGTERM → SIGKILL)",
      "  /jobs log <id>       Tail the log of a job",
      "  /agents              List available subagent definitions (.blackbox/agents/*.md)",
      "  /agents reload       Re-read subagent markdown files from disk",
      "  /refs reload         Re-scan the workspace for @-reference autocomplete",
      "  /clear               Clear the chat history (keeps current mode)",
      "  /exit, exit          Quit (also Ctrl-C)",
      "",
      C.dim(
        "  Tip: press '@' at the start of a token to open a file/folder picker;",
      ),
      C.dim(
        "       referenced @path tokens are expanded into the prompt automatically.",
      ),
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

function modelOptions(current: string): SelectOption<string>[] {
  return CURATED_MODELS.map((m) => ({
    label: m,
    value: m,
    hint: m === current ? "← current" : undefined,
  }));
}

async function pickModel(
  current: string,
  rl?: readline.Interface,
): Promise<string | undefined> {
  const isTTY = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
  if (!isTTY) {
    printModels(current);
    return undefined;
  }
  console.log("");
  rl?.pause();
  let picked: string | undefined;
  try {
    const curIdx = CURATED_MODELS.indexOf(current);
    picked = await selectFromList<string>({
      title: "Select model (tool-calling capable):",
      options: modelOptions(current),
      initialIndex: curIdx >= 0 ? curIdx : 0,
      pageSize: Math.min(12, CURATED_MODELS.length),
    });
  } finally {
    rl?.resume();
  }
  if (!picked) {
    console.log(C.dim("  (selection cancelled)\n"));
    return undefined;
  }
  return picked;
}

async function pickToolCall(
  calls: ToolCallRecord[],
  rl?: readline.Interface,
): Promise<number | undefined> {
  if (calls.length === 0) return undefined;
  const isTTY = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
  if (!isTTY) return undefined;
  rl?.pause();
  try {
    const options: SelectOption<number>[] = calls.map((c, i) => ({
      label: `${i + 1}. ${c.name}(${shortenArgs(c.args)})`,
      hint: `→ ${c.result.length} chars`,
      value: i,
    }));
    const picked = await selectFromList<number>({
      title: "Select tool call:",
      options,
      pageSize: Math.min(12, calls.length),
    });
    return picked;
  } finally {
    rl?.resume();
  }
}

type PlanEntry = {
  slug: string;
  filename: string;
  absPath: string;
  relPath: string;
  done: boolean;
  mtimeMs: number;
};

async function listPlans(): Promise<PlanEntry[]> {
  const fsMod = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const dirAbs = pathMod.join(WORKSPACE_ROOT, PLANS_DIR);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsMod.readdir(dirAbs, { withFileTypes: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const results: PlanEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const isDone = name.endsWith(PLAN_DONE_SUFFIX);
    const isOpen = !isDone && name.endsWith(PLAN_FILE_SUFFIX);
    if (!isOpen && !isDone) continue;
    const slug = name.slice(
      0,
      name.length - (isDone ? PLAN_DONE_SUFFIX.length : PLAN_FILE_SUFFIX.length),
    );
    const absPath = pathMod.join(dirAbs, name);
    let mtimeMs = 0;
    try {
      const st = await fsMod.stat(absPath);
      mtimeMs = st.mtimeMs;
    } catch {
      // ignore stat failure
    }
    results.push({
      slug,
      filename: name,
      absPath,
      relPath: pathMod.join(PLANS_DIR, name),
      done: isDone,
      mtimeMs,
    });
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

async function printPlanContent(entry: PlanEntry): Promise<void> {
  const fsMod = await import("node:fs/promises");
  let content: string;
  try {
    content = await fsMod.readFile(entry.absPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(C.red(`Failed to read ${entry.relPath}: ${msg}`));
    return;
  }
  const marker = entry.done ? C.dim(" [done]") : "";
  console.log("");
  console.log(C.bold(`${entry.slug}${marker}`) + "  " + C.dim(entry.relPath));
  console.log(C.dim("─".repeat(Math.min(72, (process.stdout.columns ?? 72)))));
  console.log(content.replace(/\s+$/u, ""));
  console.log("");
}

async function pickPlan(
  plans: PlanEntry[],
  rl: readline.Interface,
  showAll: boolean,
): Promise<PlanEntry | undefined> {
  rl.pause();
  try {
    const options: SelectOption<number>[] = plans.map((p, i) => ({
      label: p.slug,
      hint: p.done ? "done" : p.relPath,
      value: i,
    }));
    const picked = await selectFromList<number>({
      title: showAll
        ? `Select a plan (${plans.length} total):`
        : `Select a plan (${plans.length} open):`,
      options,
      pageSize: Math.min(12, plans.length),
      helpHint: "  ↑↓ move · Enter open · Esc cancel",
    });
    if (picked === undefined) return undefined;
    return plans[picked];
  } finally {
    rl.resume();
  }
}

type PlanAction = "view" | "refine" | "execute";

async function pickPlanAction(
  entry: PlanEntry,
  rl: readline.Interface,
): Promise<PlanAction | undefined> {
  const isTTY = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
  if (!isTTY) return undefined;
  if (entry.done) {
    console.log(
      C.yellow(
        `  Note: "${entry.slug}" is marked done — refining or executing it will reopen work on it.`,
      ),
    );
  }
  rl.pause();
  try {
    const options: SelectOption<PlanAction>[] = [
      {
        label: "View only",
        hint: "just show the content (already printed above)",
        value: "view",
      },
      {
        label: "Refine via prompting",
        hint: "switch to plan mode and iterate on this plan",
        value: "refine",
      },
      {
        label: "Execute the plan",
        hint: "switch to agent mode and implement the steps",
        value: "execute",
      },
    ];
    const picked = await selectFromList<PlanAction>({
      title: `What do you want to do with "${entry.slug}"?`,
      options,
      pageSize: options.length,
      helpHint: "  ↑↓ move · Enter select · Esc cancel",
    });
    return picked;
  } finally {
    rl.resume();
  }
}

async function printPlans(showAll: boolean): Promise<void> {
  const all = await listPlans();
  const plans = showAll ? all : all.filter((p) => !p.done);
  console.log("");
  if (plans.length === 0) {
    if (showAll) {
      console.log(C.dim(`No plans in ${PLANS_DIR}/ yet.`));
    } else {
      const doneCount = all.filter((p) => p.done).length;
      if (doneCount > 0) {
        console.log(
          C.dim(
            `No open plans. ${doneCount} done plan${doneCount === 1 ? "" : "s"} archived — use /plans all to show.`,
          ),
        );
      } else {
        console.log(C.dim(`No plans in ${PLANS_DIR}/ yet.`));
      }
    }
    console.log("");
    return;
  }
  console.log(
    C.bold(
      showAll ? `Plans in ${PLANS_DIR}/ (${plans.length}):` : `Open plans (${plans.length}):`,
    ),
  );
  for (const p of plans) {
    const marker = p.done ? C.dim(" [done]") : "";
    console.log(`  ${p.slug}${marker}  ${C.dim(p.relPath)}`);
  }
  console.log("");
}

async function markPlanDone(rawTarget: string): Promise<void> {
  const fsMod = await import("node:fs/promises");
  const pathMod = await import("node:path");
  let target = rawTarget.trim();
  if (target.length === 0) {
    console.log(C.red("/plan done: slug is required. Usage: /plan done <slug>"));
    return;
  }
  if (target.endsWith(PLAN_DONE_SUFFIX)) {
    target = target.slice(0, -PLAN_DONE_SUFFIX.length);
  } else if (target.endsWith(PLAN_FILE_SUFFIX)) {
    target = target.slice(0, -PLAN_FILE_SUFFIX.length);
  }
  const slug = sanitizePlanSlug(target);
  if (slug.length === 0) {
    console.log(C.red(`/plan done: "${rawTarget}" is not a valid slug.`));
    return;
  }

  const dirAbs = pathMod.join(WORKSPACE_ROOT, PLANS_DIR);
  const openAbs = pathMod.join(dirAbs, `${slug}${PLAN_FILE_SUFFIX}`);
  const doneAbs = pathMod.join(dirAbs, `${slug}${PLAN_DONE_SUFFIX}`);

  try {
    await fsMod.access(openAbs);
  } catch {
    try {
      await fsMod.access(doneAbs);
      console.log(
        C.yellow(
          `/plan done: "${slug}" is already marked done (${pathMod.join(PLANS_DIR, `${slug}${PLAN_DONE_SUFFIX}`)}).`,
        ),
      );
    } catch {
      console.log(
        C.red(
          `/plan done: no plan found for slug "${slug}" in ${PLANS_DIR}/.`,
        ),
      );
    }
    return;
  }

  try {
    await fsMod.access(doneAbs);
    console.log(
      C.red(
        `/plan done: target "${slug}${PLAN_DONE_SUFFIX}" already exists. Rename or remove it first.`,
      ),
    );
    return;
  } catch {
    // target free, continue
  }

  try {
    await fsMod.rename(openAbs, doneAbs);
    console.log(
      C.green(
        `Marked plan done: ${pathMod.join(PLANS_DIR, `${slug}${PLAN_FILE_SUFFIX}`)} → ${pathMod.join(PLANS_DIR, `${slug}${PLAN_DONE_SUFFIX}`)}`,
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(C.red(`/plan done failed: ${msg}`));
  }
}

function printJobsList(): JobSummary[] {
  const jobs = listJobs();
  console.log("");
  if (jobs.length === 0) {
    console.log(C.dim("No background jobs yet."));
    console.log("");
    return jobs;
  }
  console.log(C.bold(`Jobs (${jobs.length}):`));
  for (const j of jobs) {
    const statusColor =
      j.status === "running"
        ? C.yellow
        : j.status === "done"
          ? C.green
          : j.status === "error"
            ? C.red
            : C.dim;
    const exit =
      j.exitCode !== undefined && j.exitCode !== null
        ? ` exit=${j.exitCode}`
        : "";
    console.log(
      `  ${j.id.padEnd(6)} ${j.kind.padEnd(8)} ${statusColor(j.status.padEnd(9))} ${formatRuntime(j.runtimeMs).padStart(8)}${exit}  ${C.dim(j.label)}`,
    );
  }
  console.log("");
  return jobs;
}

function printJobLog(jobId: string): void {
  const log = readJobLog(jobId);
  console.log("");
  console.log(log);
  console.log("");
}

type PickedJob = { action: "log" | "kill"; job: JobSummary };

async function pickJob(
  jobs: JobSummary[],
  rl: readline.Interface,
): Promise<PickedJob | undefined> {
  const isTTY = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
  if (!isTTY || jobs.length === 0) return undefined;
  rl.pause();
  try {
    const options: SelectOption<number>[] = jobs.map((j, i) => ({
      label: `${j.id} ${j.kind} ${j.status}`,
      hint: `${formatRuntime(j.runtimeMs)}  ${j.label.slice(0, 60)}`,
      value: i,
    }));
    const result = await selectFromListEx<number>({
      title: `Select job (${jobs.length}):`,
      options,
      pageSize: Math.min(12, jobs.length),
      actionKeys: ["delete", "backspace"],
      helpHint: "  ↑↓ move · Enter show log · Del kill · Esc cancel",
    });
    if (!result) return undefined;
    const job = jobs[result.value];
    if (!job) return undefined;
    return {
      action: result.type === "action" ? "kill" : "log",
      job,
    };
  } finally {
    rl.resume();
  }
}

function printAgents(): void {
  const reg = getAgentRegistry();
  const agents = listAgents();
  console.log("");
  if (agents.length === 0) {
    console.log(
      C.dim(
        `No subagents configured. Drop markdown files into:\n  ${AGENTS_DIRS.project}\n  ${AGENTS_DIRS.user}`,
      ),
    );
  } else {
    console.log(C.bold(`Subagents (${agents.length}):`));
    for (const a of agents) {
      const toolInfo =
        a.tools === null ? "all tools" : `tools: ${a.tools.join(", ") || "(none)"}`;
      const modelInfo = a.model ?? "(inherits main model)";
      const desc = a.description.length > 0 ? ` — ${a.description}` : "";
      console.log(`  ${C.bold(a.name)}${C.dim(desc)}`);
      console.log(C.dim(`    model: ${modelInfo}`));
      console.log(C.dim(`    ${toolInfo}`));
      console.log(C.dim(`    source: ${a.source}`));
    }
  }
  if (reg.errors.length > 0) {
    console.log("");
    console.log(C.yellow("Load errors:"));
    for (const e of reg.errors) {
      console.log(C.yellow(`  - ${e}`));
    }
  }
  console.log("");
}

function makeAskUser(
  rl: readline.Interface,
  spinner: Spinner,
): AskUserHandler {
  return async (request: AskUserRequest): Promise<string> => {
    spinner.stop();
    console.log("");
    console.log(C.bold(C.magenta("?")) + " " + C.bold(request.question));
    try {
      if (request.type === "choice") {
        const opts: SelectOption<string>[] = (request.options ?? []).map(
          (label) => ({ label, value: label }),
        );
        rl.pause();
        let picked: string | undefined;
        try {
          picked = await selectFromList<string>({
            options: opts,
            pageSize: Math.min(opts.length, 6),
            helpHint: "  ↑↓ move · Enter select · Esc skip",
          });
        } finally {
          rl.resume();
        }
        console.log("");
        return picked ?? "";
      }
      const answer = await rl.question(C.dim("  answer > "));
      return answer;
    } finally {
      spinner.start("working…");
    }
  };
}

async function main(): Promise<void> {
  const initial = resolveInitialModel();
  let model = initial.model;
  let mode: Mode = "agent";
  let history = buildInitialHistory(SYSTEM_PROMPT);
  let lastToolCalls: ToolCallRecord[] = [];
  const spinner = createSpinner();

  const systemPromptFor = (m: Mode): string =>
    m === "plan" ? PLAN_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const promptPrefix = (): string =>
    mode === "plan" ? C.bold(C.magenta("plan > ")) : C.bold("> ");

  console.log(C.bold(C.cyan("blackbox") + " — minimal CLI coding agent"));
  console.log(C.dim(`  Workspace: ${WORKSPACE_ROOT}`));

  const isTTY = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
  if (initial.source === "default" && isTTY) {
    console.log(
      C.dim(
        "  No model set yet — pick one (Esc to skip and use the default).",
      ),
    );
    const picked = await selectFromList<string>({
      title: "Select a default model:",
      options: modelOptions(model),
      initialIndex: Math.max(0, CURATED_MODELS.indexOf(model)),
      pageSize: Math.min(12, CURATED_MODELS.length),
    });
    if (picked) model = picked;
  }
  persistModel(model);
  setSubagentFallbackModel(model);

  const agentRegistryAtStart = getAgentRegistry();

  console.log(C.dim(`  Model:     ${model}`));
  console.log(C.dim(`  Mode:      ${mode} (use /plan or /agent to switch)`));
  if (agentRegistryAtStart.agents.size > 0) {
    console.log(
      C.dim(
        `  Subagents: ${agentRegistryAtStart.agents.size} loaded (use /agents to list)`,
      ),
    );
  }
  if (agentRegistryAtStart.errors.length > 0) {
    for (const err of agentRegistryAtStart.errors) {
      console.log(C.yellow(`  subagent load error: ${err}`));
    }
  }
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

  // @-reference picker wiring: capture readline's existing keypress listeners
  // upfront so we can briefly detach them while our filterable picker takes
  // over stdin, and reattach them afterwards.
  type KpListener = (...args: unknown[]) => void;
  const rlKeypressListeners = (input.listeners("keypress") as KpListener[]).slice();
  let pickerActive = false;

  if (isTTY) {
    scanWorkspace().catch(() => {
      // best-effort; errors surface when the user tries to use @
    });
  }

  const refreshRlLine = (): void => {
    const anyRl = rl as unknown as { _refreshLine?: () => void };
    if (typeof anyRl._refreshLine === "function") {
      try {
        anyRl._refreshLine();
      } catch {
        // ignore; private API
      }
    }
  };

  const openRefPicker = async (): Promise<void> => {
    if (pickerActive) return;
    if (currentAbort !== null) return;
    if (!isTTY) return;
    const line = rl.line ?? "";
    if (!line.endsWith("@")) return;
    const prev = line.length >= 2 ? line[line.length - 2] : undefined;
    if (prev !== undefined && !/\s/.test(prev)) return;

    pickerActive = true;
    try {
      for (const l of rlKeypressListeners) input.off("keypress", l);
      rl.pause();
      const picked = await pickPath({});
      rl.resume();
      for (const l of rlKeypressListeners) input.on("keypress", l);
      if (picked) {
        const insert = picked.isDirectory
          ? picked.relPath.replace(/\/?$/, "/")
          : picked.relPath;
        rl.write(insert);
      } else {
        refreshRlLine();
      }
    } catch (err) {
      for (const l of rlKeypressListeners) {
        if (!input.listeners("keypress").includes(l)) {
          input.on("keypress", l);
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\n${C.red(`@-picker error: ${msg}`)}`);
      refreshRlLine();
    } finally {
      pickerActive = false;
    }
  };

  const onAtKeypress = (str: string | undefined): void => {
    if (pickerActive) return;
    if (currentAbort !== null) return;
    if (str !== "@") return;
    setImmediate(() => {
      void openRefPicker();
    });
  };
  input.on("keypress", onAtKeypress);

  const clearExitConfirm = (): void => {
    pendingExitConfirm = false;
    if (exitConfirmTimer) {
      clearTimeout(exitConfirmTimer);
      exitConfirmTimer = null;
    }
  };

  const shutdownJobs = (): void => {
    const running = countRunning();
    if (running > 0) {
      console.log(
        C.dim(`  terminating ${running} background job${running === 1 ? "" : "s"}…`),
      );
      killAll();
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
      shutdownJobs();
      rl.close();
      process.exit(0);
    }
    pendingExitConfirm = true;
    exitConfirmTimer = setTimeout(() => {
      pendingExitConfirm = false;
      exitConfirmTimer = null;
    }, 2000);
    const runningHint =
      countRunning() > 0
        ? C.yellow(`Press Ctrl-C again within 2s to exit (will kill ${countRunning()} job${countRunning() === 1 ? "" : "s"}).`)
        : C.yellow("Press Ctrl-C again within 2s to exit.");
    process.stdout.write(
      "\r\x1b[2K" +
      runningHint +
      "\n" +
      promptPrefix(),
    );
  });

  const runOneTurn = async (userContent: UserContent): Promise<void> => {
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

    const runOptions: RunAgentOptions =
      mode === "plan"
        ? {
          toolSchemas: PLAN_TOOL_SCHEMAS,
          askUser: makeAskUser(rl, spinner),
        }
        : { toolSchemas: AGENT_TOOL_SCHEMAS };

    const runningBg = countRunning();
    const spinnerLabel =
      runningBg > 0
        ? `working… (${runningBg} bg job${runningBg === 1 ? "" : "s"})`
        : "working…";
    spinner.start(spinnerLabel);
    try {
      const { answer, toolCalls } = await runAgent(
        history,
        userContent,
        model,
        reporter,
        abort.signal,
        runOptions,
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
  };

  while (true) {
    let line: string;
    try {
      line = await rl.question(promptPrefix());
    } catch {
      break;
    }

    const entry = line.trim();
    if (entry.length === 0) continue;

    if (entry === "exit" || entry === "/exit" || entry === "quit") {
      shutdownJobs();
      break;
    }

    if (entry === "/help") {
      printHelp();
      continue;
    }

    if (entry === "/clear") {
      history = buildInitialHistory(systemPromptFor(mode));
      lastToolCalls = [];
      console.log(
        C.dim(
          `History cleared (${mode} mode).`,
        ),
      );
      continue;
    }

    if (entry === "/plan") {
      if (mode === "plan") {
        console.log(C.dim("Already in plan mode."));
      } else {
        mode = "plan";
        history = buildInitialHistory(PLAN_SYSTEM_PROMPT);
        lastToolCalls = [];
        console.log(
          C.magenta("Plan mode active.") +
          C.dim(
            ` Read-only; writes plans to ${PLANS_DIR}/<slug>${PLAN_FILE_SUFFIX}. Use /agent to leave.`,
          ),
        );
      }
      continue;
    }

    if (entry === "/agent") {
      if (mode === "agent") {
        console.log(C.dim("Already in agent mode."));
      } else {
        mode = "agent";
        history = buildInitialHistory(SYSTEM_PROMPT);
        lastToolCalls = [];
        console.log(C.green("Agent mode active."));
      }
      continue;
    }

    if (entry === "/plans" || entry === "/plans all") {
      const showAll = entry === "/plans all";
      const all = await listPlans();
      const filtered = showAll ? all : all.filter((p) => !p.done);
      const tty = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
      if (filtered.length === 0 || !tty) {
        await printPlans(showAll);
        continue;
      }
      await printPlans(showAll);
      const picked = await pickPlan(filtered, rl, showAll);
      if (!picked) {
        console.log(C.dim("  (no plan opened)\n"));
        continue;
      }
      await printPlanContent(picked);
      const action = await pickPlanAction(picked, rl);
      if (!action || action === "view") continue;

      if (action === "refine") {
        const fsMod = await import("node:fs/promises");
        let planContent: string;
        try {
          planContent = await fsMod.readFile(picked.absPath, "utf8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(C.red(`Failed to re-read ${picked.relPath}: ${msg}`));
          continue;
        }
        if (mode !== "plan") {
          mode = "plan";
          history = buildInitialHistory(PLAN_SYSTEM_PROMPT);
          lastToolCalls = [];
        } else {
          history = buildInitialHistory(PLAN_SYSTEM_PROMPT);
          lastToolCalls = [];
        }
        console.log(
          C.magenta("Plan mode active.") +
          C.dim(` Refining ${picked.slug}.`),
        );
        const seed =
          `I want to refine the plan \`${picked.slug}\` at ${picked.relPath}.\n\n` +
          `Current content:\n\n${planContent.replace(/\s+$/u, "")}\n\n` +
          `Ask me one concrete question via ask_user about what I want to change, then update the file using write_plan with the same slug "${picked.slug}". Do not call write_plan until you have my answer.`;
        await runOneTurn(seed);
        continue;
      }

      if (action === "execute") {
        if (mode !== "agent") {
          mode = "agent";
          history = buildInitialHistory(SYSTEM_PROMPT);
          lastToolCalls = [];
        } else {
          history = buildInitialHistory(SYSTEM_PROMPT);
          lastToolCalls = [];
        }
        console.log(
          C.green("Agent mode active.") +
          C.dim(` Executing ${picked.slug}.`),
        );
        const seed =
          `Implement the plan at ${picked.relPath} (slug: ${picked.slug}). ` +
          `First read it with read_file, then execute the Steps section end-to-end. ` +
          `If something is ambiguous, stop and ask instead of guessing. ` +
          `Do not mark the plan as done; the user will do that afterwards.`;
        await runOneTurn(seed);
        continue;
      }
      continue;
    }

    if (entry.startsWith("/plan done")) {
      const rest =
        entry === "/plan done" ? "" : entry.slice("/plan done ".length).trim();
      await markPlanDone(rest);
      continue;
    }

    if (entry === "/jobs") {
      const jobs = printJobsList();
      if (jobs.length > 0) {
        const picked = await pickJob(jobs, rl);
        if (picked) {
          if (picked.action === "kill") {
            console.log("");
            console.log(killJob(picked.job.id));
            console.log("");
          } else {
            printJobLog(picked.job.id);
          }
        }
      }
      continue;
    }

    if (entry.startsWith("/jobs kill")) {
      const rest =
        entry === "/jobs kill" ? "" : entry.slice("/jobs kill ".length).trim();
      if (rest.length === 0) {
        console.log(C.red("/jobs kill: job id required. Usage: /jobs kill <id>"));
      } else {
        console.log(killJob(rest));
      }
      continue;
    }

    if (entry.startsWith("/jobs log")) {
      const rest =
        entry === "/jobs log" ? "" : entry.slice("/jobs log ".length).trim();
      if (rest.length === 0) {
        console.log(C.red("/jobs log: job id required. Usage: /jobs log <id>"));
      } else {
        printJobLog(rest);
      }
      continue;
    }

    if (entry === "/agents") {
      printAgents();
      continue;
    }

    if (entry === "/agents reload") {
      const reg = getAgentRegistry(true);
      console.log(
        C.green(
          `Reloaded subagents: ${reg.agents.size} loaded${reg.errors.length > 0 ? `, ${reg.errors.length} error(s)` : ""}.`,
        ),
      );
      for (const e of reg.errors) console.log(C.yellow(`  - ${e}`));
      continue;
    }

    if (entry === "/refs reload") {
      invalidateRefsCache();
      try {
        const entries = await scanWorkspace(true);
        console.log(
          C.green(`Rescanned workspace: ${entries.length} entries cached.`),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(C.red(`/refs reload failed: ${msg}`));
      }
      continue;
    }

    if (entry === "/tools") {
      printTools(lastToolCalls);
      continue;
    }

    if (entry.startsWith("/tool ") || entry === "/tool") {
      const rest = entry === "/tool" ? "" : entry.slice("/tool ".length).trim();
      if (rest.length === 0) {
        if (lastToolCalls.length === 0) {
          console.log(
            C.dim("  No tool calls from the last run yet. Run a prompt first."),
          );
        } else {
          const picked = await pickToolCall(lastToolCalls, rl);
          if (picked !== undefined) {
            printToolDetail(lastToolCalls, String(picked + 1));
          }
        }
      } else {
        printToolDetail(lastToolCalls, rest);
      }
      continue;
    }

    if (entry === "/models") {
      const picked = await pickModel(model, rl);
      if (picked && picked !== model) {
        model = picked;
        persistModel(model);
        setSubagentFallbackModel(model);
        console.log(C.green(`Switched model to: ${model}\n`));
      } else if (picked === model) {
        console.log(C.dim(`  Model unchanged: ${model}\n`));
      }
      continue;
    }

    if (entry === "/model") {
      console.log(
        C.dim(
          `Current model: ${model}\n  Tip: /models for interactive picker, /model <slug> to set directly.`,
        ),
      );
      continue;
    }

    if (entry.startsWith("/model ")) {
      const newModel = entry.slice("/model ".length).trim();
      if (newModel.length === 0) {
        console.log(C.red("Please provide a model slug."));
      } else {
        model = newModel;
        persistModel(model);
        setSubagentFallbackModel(model);
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

    const refsResult = await resolveRefs(promptSource);
    for (const w of refsResult.warnings) {
      console.log(C.yellow(`  ${w}`));
    }
    if (refsResult.refs.length > 0) {
      for (const ref of refsResult.refs) {
        const marker =
          ref.kind === "file"
            ? `${ref.content.length} chars`
            : ref.note;
        console.log(C.dim(`  referenced: @${ref.relPath} (${ref.kind}, ${marker})`));
      }
    }
    const refsBlock = formatRefsBlock(refsResult.refs);

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

    const baseText = text.length > 0 ? text : images.length > 0 ? "" : promptSource;
    const finalText =
      refsBlock.length > 0
        ? baseText.length > 0
          ? `${refsBlock}\n\n---\n\n${baseText}`
          : refsBlock
        : baseText;
    if (images.length === 0 && finalText.length === 0) continue;

    const userContent = buildUserContent(finalText, images);
    await runOneTurn(userContent);
  }

  rl.close();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`Fatal error: ${msg}`);
  process.exit(1);
});
