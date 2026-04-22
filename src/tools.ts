import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { tool } from "@openrouter/agent";
import type { Tool } from "@openrouter/agent";

import { assertInside, relToWorkspace } from "./sandbox.ts";
import {
  killJob,
  listJobs,
  readJobLog,
  spawnShellJob,
} from "./jobs.ts";
import {
  BASH_MAX_BUFFER_BYTES,
  BASH_TIMEOUT_MS,
  FETCH_DEFAULT_MAX_BYTES,
  FETCH_MAX_BYTES_CAP,
  FETCH_TIMEOUT_MS,
  FETCH_USER_AGENT,
  LIST_MAX_DEPTH,
  LIST_MAX_ENTRIES,
  LIST_SKIP,
  PLAN_DONE_SUFFIX,
  PLAN_FILE_SUFFIX,
  PLANS_DIR,
  WORKSPACE_ROOT,
} from "./config.ts";
import { formatRuntime, truncate } from "./utils/format.ts";
import { stripHtml } from "./utils/html.ts";
import { sanitizePlanSlug } from "./utils/slug.ts";

export type AskUserRequest = {
  question: string;
  type: "choice" | "text";
  options?: string[];
};

export type AskUserHandler = (
  request: AskUserRequest,
  signal?: AbortSignal,
) => Promise<string>;

const AskUserContextSchema = z.object({
  askUser: z.custom<AskUserHandler>((v) => typeof v === "function"),
});

const readFile = tool({
  name: "read_file",
  description:
    "Read a text file (or a slice of it) from the workspace. Paths are relative to WORKSPACE_ROOT. Output lines are prefixed with their 1-based line number. Use 'offset' and 'limit' to read specific ranges of large files; otherwise, long contents are truncated automatically.",
  inputSchema: z.object({
    path: z.string().describe("Relative path to the file inside the workspace."),
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("1-based starting line number. Default: 1."),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Maximum number of lines to return starting from 'offset'. Default: until end of file.",
      ),
  }),
  execute: async (args) => {
    const abs = assertInside(args.path);
    const content = await fs.readFile(abs, "utf8");
    const allLines = content.split("\n");
    const total = allLines.length;

    const offsetRaw = args.offset ?? 1;
    const offset = Math.max(1, Math.floor(offsetRaw));
    const limit =
      args.limit !== undefined ? Math.max(1, Math.floor(args.limit)) : total;

    const start = Math.min(offset, Math.max(total, 1));
    const end = Math.min(start + limit - 1, total);
    const slice = total === 0 ? [] : allLines.slice(start - 1, end);

    const numbered = slice
      .map((line, i) => `${String(start + i).padStart(6, " ")}|${line}`)
      .join("\n");

    const rangeInfo =
      total === 0 ? "empty" : `lines ${start}-${end} of ${total}`;
    const header = `# ${relToWorkspace(abs)} [${rangeInfo}]`;
    return truncate(`${header}\n${numbered}`, {
      hint: "use read_file with offset/limit to read specific line ranges",
    });
  },
});

const listFiles = tool({
  name: "list_files",
  description:
    "List files and subdirectories starting from the given directory up to depth 2. Folders like node_modules, .git and dist are skipped.",
  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe("Relative folder path inside the workspace. Default: workspace root."),
  }),
  execute: async (args) => {
    const target = args.path && args.path.length > 0 ? args.path : ".";
    const abs = assertInside(target);

    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) {
      throw new Error(`list_files expects a directory, got a file: ${target}`);
    }

    const results: string[] = [];

    async function walk(dir: string, depth: number): Promise<void> {
      if (results.length >= LIST_MAX_ENTRIES) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (results.length >= LIST_MAX_ENTRIES) return;
        if (LIST_SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const rel = relToWorkspace(full);
        if (entry.isDirectory()) {
          results.push(`${rel}/`);
          if (depth < LIST_MAX_DEPTH) {
            await walk(full, depth + 1);
          }
        } else if (entry.isFile()) {
          results.push(rel);
        } else if (entry.isSymbolicLink()) {
          results.push(`${rel} (symlink)`);
        }
      }
    }

    await walk(abs, 1);

    const header = `# ${relToWorkspace(abs)} (up to ${LIST_MAX_ENTRIES} entries, depth ${LIST_MAX_DEPTH})`;
    const body = results.length > 0 ? results.join("\n") : "(empty)";
    return truncate(`${header}\n${body}`);
  },
});

const editFile = tool({
  name: "edit_file",
  description:
    "Write the given content to a file (overwrite). Creates missing parent directories inside the workspace.",
  inputSchema: z.object({
    path: z.string().describe("Relative path to the target file inside the workspace."),
    content: z.string().describe("The full new file contents as a string."),
  }),
  execute: async (args) => {
    const abs = assertInside(args.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, args.content, "utf8");
    const bytes = Buffer.byteLength(args.content, "utf8");
    return `Wrote ${relToWorkspace(abs)} (${bytes} bytes)`;
  },
});

const writePlan = tool({
  name: "write_plan",
  description: `Write the final plan as markdown to ${PLANS_DIR}/<slug>${PLAN_FILE_SUFFIX}. Call this exactly once at the end of planning. The slug must be a short kebab-case identifier (lowercase a-z, digits, '-'). Do not include the file suffix in the slug. Plan mode only.`,
  inputSchema: z.object({
    slug: z
      .string()
      .min(1)
      .describe("Short kebab-case identifier, e.g. 'add-plan-mode'. Used as the filename."),
    title: z
      .string()
      .min(1)
      .describe("Human-readable plan title. Used as '# Title' if the content does not already start with one."),
    content: z
      .string()
      .min(1)
      .describe("Full markdown body of the plan. Should include sections: Goal, Affected Files, Steps, Open Questions, Test Plan."),
  }),
  execute: async (args) => {
    const slug = sanitizePlanSlug(args.slug);
    if (slug.length === 0) {
      throw new Error(
        `write_plan: slug "${args.slug}" contains no usable characters (need a-z, 0-9, '-')`,
      );
    }

    const relPath = path.join(PLANS_DIR, `${slug}${PLAN_FILE_SUFFIX}`);
    const abs = assertInside(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });

    const donePath = path.join(
      path.dirname(abs),
      `${slug}${PLAN_DONE_SUFFIX}`,
    );
    let doneExisted = false;
    try {
      await fs.access(donePath);
      doneExisted = true;
    } catch {
      // not done yet, fine
    }

    const trimmed = args.content.replace(/^\s+|\s+$/g, "");
    const firstLine = trimmed.split("\n", 1)[0] ?? "";
    const body = firstLine.startsWith("# ")
      ? trimmed
      : `# ${args.title}\n\n${trimmed}`;
    const final = body.endsWith("\n") ? body : `${body}\n`;

    await fs.writeFile(abs, final, "utf8");
    const bytes = Buffer.byteLength(final, "utf8");
    const note = doneExisted
      ? ` (note: a previous ${slug}${PLAN_DONE_SUFFIX} also exists)`
      : "";
    return `Wrote plan to ${relToWorkspace(abs)} (${bytes} bytes)${note}`;
  },
});

const fetchUrl = tool({
  name: "fetch_url",
  description:
    "Fetch a public URL over http(s) and return its content as text. HTML is stripped to readable text, JSON is pretty-printed, plain text is returned as-is. Use this to read documentation pages, blog posts or JSON API responses. Follows redirects, 15s timeout.",
  inputSchema: z.object({
    url: z.string().min(1).describe("Absolute http:// or https:// URL to fetch."),
    max_bytes: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Optional maximum number of bytes to read from the response body. Default 500000, capped at 5000000.",
      ),
  }),
  execute: async (args) => {
    let parsed: URL;
    try {
      parsed = new URL(args.url);
    } catch {
      throw new Error(`Invalid URL: ${args.url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Only http(s) URLs are supported, got: ${parsed.protocol}`);
    }

    const maxBytes =
      typeof args.max_bytes === "number" && args.max_bytes > 0
        ? Math.min(args.max_bytes, FETCH_MAX_BYTES_CAP)
        : FETCH_DEFAULT_MAX_BYTES;

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(parsed.toString(), {
        redirect: "follow",
        signal: ctrl.signal,
        headers: {
          "User-Agent": FETCH_USER_AGENT,
          Accept: "text/html,text/plain,application/json,*/*;q=0.8",
        },
      });

      const contentType = res.headers.get("content-type") ?? "unknown";
      const finalUrl = res.url || parsed.toString();

      if (!res.body) {
        const text = await res.text();
        return truncate(
          `URL: ${finalUrl}\nStatus: ${res.status}\nContent-Type: ${contentType}\n\n${text}`,
        );
      }

      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let truncatedByCap = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (received + value.byteLength > maxBytes) {
          const remain = maxBytes - received;
          if (remain > 0) chunks.push(value.subarray(0, remain));
          truncatedByCap = true;
          try {
            await reader.cancel();
          } catch {
            // ignore cancel errors
          }
          break;
        }
        chunks.push(value);
        received += value.byteLength;
      }

      const raw = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");

      let body: string;
      if (contentType.includes("application/json")) {
        try {
          body = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          body = raw;
        }
      } else if (
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml")
      ) {
        body = stripHtml(raw);
      } else {
        body = raw;
      }

      const capNote = truncatedByCap
        ? `\n[body capped at ${maxBytes} bytes]`
        : "";
      return truncate(
        `URL: ${finalUrl}\nStatus: ${res.status}\nContent-Type: ${contentType}${capNote}\n\n${body}`,
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Timeout while fetching ${parsed.toString()} (${Math.round(FETCH_TIMEOUT_MS / 1000)}s)`,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`fetch failed: ${msg}`);
    } finally {
      clearTimeout(timeout);
    }
  },
});

const executeBash = tool({
  name: "execute_bash",
  description:
    "Run a shell command in WORKSPACE_ROOT (cwd is pinned, timeout 30s). Returns combined stdout/stderr plus exit code. Please only use relative paths inside the workspace.",
  inputSchema: z.object({
    command: z.string().min(1).describe("The shell command to execute."),
  }),
  execute: async (args) => {
    return new Promise<string>((resolve) => {
      const child = spawn(args.command, {
        cwd: WORKSPACE_ROOT,
        shell: true,
        env: { ...process.env, PWD: WORKSPACE_ROOT },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let settled = false;

      const killTree = (sig: NodeJS.Signals = "SIGTERM"): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            // process is probably already gone
          }
        }
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        setTimeout(() => {
          if (!settled) killTree("SIGKILL");
        }, 2_000);
      }, BASH_TIMEOUT_MS);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutBytes >= BASH_MAX_BUFFER_BYTES) return;
        const remaining = BASH_MAX_BUFFER_BYTES - stdoutBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        stdout += slice.toString("utf8");
        stdoutBytes += slice.length;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBytes >= BASH_MAX_BUFFER_BYTES) return;
        const remaining = BASH_MAX_BUFFER_BYTES - stderrBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        stderr += slice.toString("utf8");
        stderrBytes += slice.length;
      });

      const finish = (body: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(truncate(body));
      };

      child.on("error", (err: Error) => {
        finish(
          `exit_code: null\nerror: ${err.message}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      });

      child.on("close", (code: number | null, sigName: NodeJS.Signals | null) => {
        if (timedOut) {
          finish(
            `exit_code: null signal=${sigName ?? "SIGTERM"}\nerror: command timed out after ${Math.round(BASH_TIMEOUT_MS / 1000)}s\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
          );
          return;
        }
        if (code === 0 && !sigName) {
          finish(`exit_code: 0\n${stdout}`);
          return;
        }
        const sigInfo = sigName ? ` signal=${sigName}` : "";
        finish(
          `exit_code: ${code ?? "null"}${sigInfo}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      });
    });
  },
});

const spawnBackground = tool({
  name: "spawn_background",
  description:
    "Start a long-running shell command in the background (e.g. 'yarn dev', file watchers, servers) WITHOUT blocking the agent. Returns a job id immediately. Use read_job_log to inspect output and kill_job to stop. Prefer this over execute_bash for anything that does not terminate quickly or that you need to keep running while you continue working.",
  inputSchema: z.object({
    command: z.string().min(1).describe("The shell command to run in WORKSPACE_ROOT."),
  }),
  execute: async (args) => {
    const job = spawnShellJob(args.command);
    return `Started shell job ${job.id} for: ${args.command}\nUse read_job_log('${job.id}') to inspect output, kill_job('${job.id}') to stop.`;
  },
});

const listJobsT = tool({
  name: "list_jobs",
  description:
    "List all background shell jobs and subagent jobs in this session with id, kind, status and runtime.",
  inputSchema: z.object({}),
  execute: async () => {
    const jobs = listJobs();
    if (jobs.length === 0) return "(no jobs)";
    const rows = jobs.map((j) => {
      const runtime = formatRuntime(j.runtimeMs);
      const exit =
        j.exitCode !== undefined && j.exitCode !== null
          ? ` exit=${j.exitCode}`
          : "";
      return `${j.id}  ${j.kind.padEnd(8)}  ${j.status.padEnd(9)}  ${runtime.padStart(8)}${exit}  ${j.label}`;
    });
    const header = `id     kind      status     runtime   label`;
    return `${header}\n${"-".repeat(header.length)}\n${rows.join("\n")}`;
  },
});

const readJobLogT = tool({
  name: "read_job_log",
  description:
    "Read the last N lines of a job's combined stdout/stderr log (shell jobs) or trace log (subagents).",
  inputSchema: z.object({
    job_id: z.string().min(1).describe("Job id, e.g. 'sh_1' or 'sa_2'."),
    tail: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("How many lines to return from the end. Default 200, max 5000."),
  }),
  execute: async (args) => {
    return truncate(readJobLog(args.job_id, args.tail));
  },
});

const killJobT = tool({
  name: "kill_job",
  description:
    "Terminate a running job. Shell jobs get SIGTERM (escalates to SIGKILL after 2s). Subagents are aborted.",
  inputSchema: z.object({
    job_id: z.string().min(1).describe("Job id to terminate."),
  }),
  execute: async (args) => {
    return killJob(args.job_id);
  },
});

const listSubagents = tool({
  name: "list_subagents",
  description:
    "List available subagent definitions loaded from .blackbox/agents/*.md (project) and ~/.blackbox/agents/*.md (user). Each entry shows the agent name, description, model and allowed tools.",
  inputSchema: z.object({}),
  execute: async () => {
    const { listAgentsForDisplay, getAgentRegistry } = await import(
      "./subagents.ts"
    );
    const reg = getAgentRegistry();
    const errBlock =
      reg.errors.length > 0
        ? `\n\nload errors:\n${reg.errors.map((e) => `  - ${e}`).join("\n")}`
        : "";
    return listAgentsForDisplay() + errBlock;
  },
});

let subagentFallbackModel = "";

export function setSubagentFallbackModel(model: string): void {
  subagentFallbackModel = model;
}

const spawnSubagent = tool({
  name: "spawn_subagent",
  description:
    "Start a subagent LLM run asynchronously WITHOUT blocking. Returns a job id immediately. The subagent runs with its own system prompt, model and tool whitelist as defined in its markdown file. Use list_subagents to discover available agents, subagent_result(job_id) to fetch the final answer once done, and read_job_log to watch progress.",
  inputSchema: z.object({
    agent: z.string().min(1).describe("Name of a subagent from list_subagents."),
    task: z
      .string()
      .min(1)
      .describe("The task description passed as the user message to the subagent."),
  }),
  execute: async (args) => {
    if (!subagentFallbackModel) {
      return "Error: subagent fallback model is not configured. This is an internal bug.";
    }
    const { spawnSubagentJob } = await import("./subagents.ts");
    const result = spawnSubagentJob(args.agent, args.task, {
      fallbackModel: subagentFallbackModel,
    });
    if ("error" in result) return result.error;
    const { job } = result;
    return `Started subagent job ${job.id} (agent=${args.agent}).\nUse subagent_result('${job.id}') to fetch the final answer once status='done', or read_job_log('${job.id}') to watch progress.`;
  },
});

const subagentResult = tool({
  name: "subagent_result",
  description:
    "Fetch the final answer of a subagent job. If the job is still running, returns a hint to retry later.",
  inputSchema: z.object({
    job_id: z.string().min(1).describe("Subagent job id (e.g. 'sa_1')."),
  }),
  execute: async (args) => {
    const { getJob } = await import("./jobs.ts");
    const job = getJob(args.job_id);
    if (!job) return `Error: unknown job id '${args.job_id}'`;
    if (job.kind !== "subagent") {
      return `Error: job '${args.job_id}' is a ${job.kind} job, not a subagent. Use read_job_log instead.`;
    }
    const runtime = formatRuntime((job.endedAt ?? Date.now()) - job.startedAt);
    if (job.status === "running") {
      return `Job ${job.id} is still running (${runtime}). Check again later or use read_job_log('${job.id}') to see progress.`;
    }
    if (job.status === "error") {
      return `Job ${job.id} failed after ${runtime}: ${job.error ?? "(no error message)"}`;
    }
    if (job.status === "cancelled") {
      return `Job ${job.id} was cancelled after ${runtime}.`;
    }
    return `Job ${job.id} done in ${runtime}.\n\n--- result ---\n${truncate(job.result ?? "(empty)")}`;
  },
});

const askUser = tool({
  name: "ask_user",
  description:
    "Ask the developer a short clarifying question and get their answer back. Use type='choice' with 2-6 concrete options whenever possible; only use type='text' when free-form input is truly needed. Plan mode only.",
  inputSchema: z.object({
    question: z
      .string()
      .min(1)
      .describe("The question shown to the user. Keep it short and specific."),
    type: z
      .enum(["choice", "text"])
      .describe(
        "'choice' shows a multiple-choice picker using the 'options' field. 'text' asks for free-form input.",
      ),
    options: z
      .array(z.string())
      .optional()
      .describe("For type='choice': 2-6 option labels. Ignored for type='text'."),
  }),
  contextSchema: AskUserContextSchema,
  execute: async (args, ctx) => {
    if (args.type === "choice") {
      const raw = args.options ?? [];
      const cleaned = raw.map((v) => v.trim()).filter((v) => v.length > 0);
      if (cleaned.length < 2) {
        return "Error: ask_user with type='choice' needs an 'options' array with at least 2 non-empty entries.";
      }
    }

    const handler = ctx?.local?.askUser;
    if (typeof handler !== "function") {
      return "Error: ask_user is only available in plan mode. Do not call this tool.";
    }

    try {
      const answer = await handler({
        question: args.question,
        type: args.type,
        options: args.type === "choice" ? args.options : undefined,
      });
      const trimmed = (answer ?? "").trim();
      if (trimmed.length === 0) {
        return "User provided no answer (empty or cancelled). Ask again with a clearer question, or proceed with your best assumption and note the open question in the plan.";
      }
      return JSON.stringify({ answer: trimmed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error asking user: ${msg}`;
    }
  },
});

export const AGENT_TOOLS = [
  readFile,
  listFiles,
  fetchUrl,
  editFile,
  executeBash,
  spawnBackground,
  listJobsT,
  readJobLogT,
  killJobT,
  listSubagents,
  spawnSubagent,
  subagentResult,
] as const;

export const PLAN_TOOLS = [
  readFile,
  listFiles,
  fetchUrl,
  askUser,
  writePlan,
] as const;

export const ALL_TOOL_NAMES: readonly string[] = Array.from(
  new Set<string>([
    ...AGENT_TOOLS.map((t) => t.function.name),
    ...PLAN_TOOLS.map((t) => t.function.name),
  ]),
);

export function filterAgentTools(allowed: Set<string> | null): Tool[] {
  if (allowed === null) return [...AGENT_TOOLS];
  return AGENT_TOOLS.filter((t) => allowed.has(t.function.name));
}
