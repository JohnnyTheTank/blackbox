import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type OpenAI from "openai";

import { assertInside, relToWorkspace } from "./sandbox.ts";
import {
  formatRuntime,
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
  HTML_ENTITIES,
  LIST_MAX_DEPTH,
  LIST_MAX_ENTRIES,
  LIST_SKIP,
  PLAN_DONE_SUFFIX,
  PLAN_FILE_SUFFIX,
  PLANS_DIR,
  TOOL_OUTPUT_MAX_CHARS,
  WORKSPACE_ROOT,
} from "./config.ts";

function truncate(text: string, options?: { hint?: string }): string {
  if (text.length <= TOOL_OUTPUT_MAX_CHARS) return text;
  const head = text.slice(0, TOOL_OUTPUT_MAX_CHARS);
  const dropped = text.length - TOOL_OUTPUT_MAX_CHARS;
  const hint = options?.hint ? ` — ${options.hint}` : "";
  return `${head}\n... [truncated, ${dropped} more characters${hint}]`;
}

async function readFileTool(args: {
  path: string;
  offset?: number;
  limit?: number;
}): Promise<string> {
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
}

async function listFilesTool(args: { path?: string }): Promise<string> {
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
}

async function editFileTool(args: {
  path: string;
  content: string;
}): Promise<string> {
  const abs = assertInside(args.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, args.content, "utf8");
  const bytes = Buffer.byteLength(args.content, "utf8");
  return `Wrote ${relToWorkspace(abs)} (${bytes} bytes)`;
}

export function sanitizePlanSlug(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const cleaned = lower
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned;
}

async function writePlanTool(args: {
  slug: string;
  title: string;
  content: string;
}): Promise<string> {
  if (typeof args.slug !== "string" || args.slug.length === 0) {
    throw new Error("write_plan requires a non-empty 'slug'");
  }
  if (typeof args.title !== "string" || args.title.length === 0) {
    throw new Error("write_plan requires a non-empty 'title'");
  }
  if (typeof args.content !== "string" || args.content.length === 0) {
    throw new Error("write_plan requires a non-empty 'content' (markdown body)");
  }

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
}

function stripHtml(html: string): string {
  let text = html;
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|li|tr)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, h) =>
    String.fromCodePoint(parseInt(h, 16)),
  );
  text = text.replace(/&[a-z]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m);
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

async function fetchUrlTool(
  args: {
    url: string;
    max_bytes?: number;
  },
  signal?: AbortSignal,
): Promise<string> {
  const rawUrl = args.url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new Error("fetch_url requires a non-empty 'url' string");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
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
  const onParentAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }

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
      if (signal?.aborted) {
        throw new Error("fetch cancelled by user");
      }
      throw new Error(
        `Timeout while fetching ${parsed.toString()} (${Math.round(FETCH_TIMEOUT_MS / 1000)}s)`,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`fetch failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", onParentAbort);
  }
}

async function executeBashTool(
  args: { command: string },
  signal?: AbortSignal,
): Promise<string> {
  const command = args.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("execute_bash requires a non-empty 'command' string");
  }

  return new Promise<string>((resolve) => {
    const child = spawn(command, {
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
    let cancelledByUser = false;
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

    const onAbort = (): void => {
      cancelledByUser = true;
      killTree("SIGTERM");
      setTimeout(() => {
        if (!settled) killTree("SIGKILL");
      }, 1_000);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

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
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(truncate(body));
    };

    child.on("error", (err: Error) => {
      finish(
        `exit_code: null\nerror: ${err.message}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    });

    child.on("close", (code: number | null, sigName: NodeJS.Signals | null) => {
      if (cancelledByUser) {
        finish(
          `exit_code: null signal=${sigName ?? "SIGTERM"}\ncancelled by user\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
        return;
      }
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
}

async function spawnBackgroundTool(args: {
  command: string;
}): Promise<string> {
  if (typeof args.command !== "string" || args.command.trim().length === 0) {
    throw new Error("spawn_background requires a non-empty 'command' string");
  }
  const job = spawnShellJob(args.command);
  return `Started shell job ${job.id} for: ${args.command}\nUse read_job_log('${job.id}') to inspect output, kill_job('${job.id}') to stop.`;
}

async function listJobsTool(): Promise<string> {
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
}

async function readJobLogTool(args: {
  job_id: string;
  tail?: number;
}): Promise<string> {
  if (typeof args.job_id !== "string" || args.job_id.length === 0) {
    throw new Error("read_job_log requires a 'job_id' string");
  }
  return truncate(readJobLog(args.job_id, args.tail));
}

async function killJobTool(args: { job_id: string }): Promise<string> {
  if (typeof args.job_id !== "string" || args.job_id.length === 0) {
    throw new Error("kill_job requires a 'job_id' string");
  }
  return killJob(args.job_id);
}

async function listSubagentsTool(): Promise<string> {
  const { listAgentsForDisplay, getAgentRegistry } = await import(
    "./subagents.ts"
  );
  const reg = getAgentRegistry();
  const errBlock =
    reg.errors.length > 0
      ? `\n\nload errors:\n${reg.errors.map((e) => `  - ${e}`).join("\n")}`
      : "";
  return listAgentsForDisplay() + errBlock;
}

let subagentFallbackModel = "";

export function setSubagentFallbackModel(model: string): void {
  subagentFallbackModel = model;
}

async function spawnSubagentTool(args: {
  agent: string;
  task: string;
}): Promise<string> {
  if (typeof args.agent !== "string" || args.agent.length === 0) {
    throw new Error("spawn_subagent requires an 'agent' name");
  }
  if (typeof args.task !== "string" || args.task.trim().length === 0) {
    throw new Error("spawn_subagent requires a non-empty 'task' string");
  }
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
}

async function subagentResultTool(args: {
  job_id: string;
}): Promise<string> {
  if (typeof args.job_id !== "string" || args.job_id.length === 0) {
    throw new Error("subagent_result requires a 'job_id' string");
  }
  const { getJob, formatRuntime: fmtRuntime } = await import("./jobs.ts");
  const job = getJob(args.job_id);
  if (!job) return `Error: unknown job id '${args.job_id}'`;
  if (job.kind !== "subagent") {
    return `Error: job '${args.job_id}' is a ${job.kind} job, not a subagent. Use read_job_log instead.`;
  }
  const runtime = fmtRuntime((job.endedAt ?? Date.now()) - job.startedAt);
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
}

type ServerTool = {
  type: `openrouter:${string}`;
  parameters?: Record<string, unknown>;
};

export type AnyTool = OpenAI.Chat.Completions.ChatCompletionTool | ServerTool;

const READ_FILE_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read a text file (or a slice of it) from the workspace. Paths are relative to WORKSPACE_ROOT. Output lines are prefixed with their 1-based line number. Use 'offset' and 'limit' to read specific ranges of large files; otherwise, long contents are truncated automatically.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file inside the workspace.",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "1-based starting line number. Default: 1.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description:
            "Maximum number of lines to return starting from 'offset'. Default: until end of file.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

const LIST_FILES_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "list_files",
    description:
      "List files and subdirectories starting from the given directory up to depth 2. Folders like node_modules, .git and dist are skipped.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative folder path inside the workspace. Default: workspace root.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

const EDIT_FILE_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "edit_file",
    description:
      "Write the given content to a file (overwrite). Creates missing parent directories inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the target file inside the workspace.",
        },
        content: {
          type: "string",
          description: "The full new file contents as a string.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
};

const EXECUTE_BASH_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "execute_bash",
    description:
      "Run a shell command in WORKSPACE_ROOT (cwd is pinned, timeout 30s). Returns combined stdout/stderr plus exit code. Please only use relative paths inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

const FETCH_URL_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "fetch_url",
    description:
      "Fetch a public URL over http(s) and return its content as text. HTML is stripped to readable text, JSON is pretty-printed, plain text is returned as-is. Use this to read documentation pages, blog posts or JSON API responses. Follows redirects, 15s timeout.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http:// or https:// URL to fetch.",
        },
        max_bytes: {
          type: "integer",
          description:
            "Optional maximum number of bytes to read from the response body. Default 500000, capped at 5000000.",
          minimum: 1,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

const WEB_SEARCH_SCHEMA: AnyTool = {
  type: "openrouter:web_search",
  parameters: {
    max_results: 5,
    max_total_results: 15,
  },
};

const DATETIME_SCHEMA: AnyTool = {
  type: "openrouter:datetime",
};

const SPAWN_BACKGROUND_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "spawn_background",
    description:
      "Start a long-running shell command in the background (e.g. 'yarn dev', file watchers, servers) WITHOUT blocking the agent. Returns a job id immediately. Use read_job_log to inspect output and kill_job to stop. Prefer this over execute_bash for anything that does not terminate quickly or that you need to keep running while you continue working.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to run in WORKSPACE_ROOT.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

const LIST_JOBS_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "list_jobs",
    description:
      "List all background shell jobs and subagent jobs in this session with id, kind, status and runtime.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};

const READ_JOB_LOG_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "read_job_log",
    description:
      "Read the last N lines of a job's combined stdout/stderr log (shell jobs) or trace log (subagents).",
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Job id, e.g. 'sh_1' or 'sa_2'.",
        },
        tail: {
          type: "integer",
          description: "How many lines to return from the end. Default 200, max 5000.",
          minimum: 1,
        },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
};

const KILL_JOB_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "kill_job",
    description:
      "Terminate a running job. Shell jobs get SIGTERM (escalates to SIGKILL after 2s). Subagents are aborted.",
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Job id to terminate.",
        },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
};

const LIST_SUBAGENTS_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "list_subagents",
    description:
      "List available subagent definitions loaded from .blackbox/agents/*.md (project) and ~/.blackbox/agents/*.md (user). Each entry shows the agent name, description, model and allowed tools.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};

const SPAWN_SUBAGENT_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "spawn_subagent",
    description:
      "Start a subagent LLM run asynchronously WITHOUT blocking. Returns a job id immediately. The subagent runs with its own system prompt, model and tool whitelist as defined in its markdown file. Use list_subagents to discover available agents, subagent_result(job_id) to fetch the final answer once done, and read_job_log to watch progress.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Name of a subagent from list_subagents.",
        },
        task: {
          type: "string",
          description:
            "The task description passed as the user message to the subagent.",
        },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    },
  },
};

const SUBAGENT_RESULT_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "subagent_result",
    description:
      "Fetch the final answer of a subagent job. If the job is still running, returns a hint to retry later.",
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Subagent job id (e.g. 'sa_1').",
        },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
};

const ASK_USER_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "ask_user",
    description:
      "Ask the developer a short clarifying question and get their answer back. Use type='choice' with 2-6 concrete options whenever possible; only use type='text' when free-form input is truly needed. Plan mode only.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question shown to the user. Keep it short and specific.",
        },
        type: {
          type: "string",
          enum: ["choice", "text"],
          description:
            "'choice' shows a multiple-choice picker using the 'options' field. 'text' asks for free-form input.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "For type='choice': 2-6 option labels. Ignored for type='text'.",
        },
      },
      required: ["question", "type"],
      additionalProperties: false,
    },
  },
};

const WRITE_PLAN_SCHEMA: AnyTool = {
  type: "function",
  function: {
    name: "write_plan",
    description:
      `Write the final plan as markdown to ${PLANS_DIR}/<slug>${PLAN_FILE_SUFFIX}. Call this exactly once at the end of planning. The slug must be a short kebab-case identifier (lowercase a-z, digits, '-'). Do not include the file suffix in the slug. Plan mode only.`,
    parameters: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "Short kebab-case identifier, e.g. 'add-plan-mode'. Used as the filename.",
        },
        title: {
          type: "string",
          description:
            "Human-readable plan title. Used as '# Title' if the content does not already start with one.",
        },
        content: {
          type: "string",
          description:
            "Full markdown body of the plan. Should include sections: Goal, Affected Files, Steps, Open Questions, Test Plan.",
        },
      },
      required: ["slug", "title", "content"],
      additionalProperties: false,
    },
  },
};

const READ_TOOL_SCHEMAS: AnyTool[] = [
  READ_FILE_SCHEMA,
  LIST_FILES_SCHEMA,
  FETCH_URL_SCHEMA,
  WEB_SEARCH_SCHEMA,
  DATETIME_SCHEMA,
];

const WRITE_TOOL_SCHEMAS: AnyTool[] = [EDIT_FILE_SCHEMA, EXECUTE_BASH_SCHEMA];

const JOB_TOOL_SCHEMAS: AnyTool[] = [
  SPAWN_BACKGROUND_SCHEMA,
  LIST_JOBS_SCHEMA,
  READ_JOB_LOG_SCHEMA,
  KILL_JOB_SCHEMA,
  LIST_SUBAGENTS_SCHEMA,
  SPAWN_SUBAGENT_SCHEMA,
  SUBAGENT_RESULT_SCHEMA,
];

export const AGENT_TOOL_SCHEMAS: AnyTool[] = [
  ...READ_TOOL_SCHEMAS,
  ...WRITE_TOOL_SCHEMAS,
  ...JOB_TOOL_SCHEMAS,
];

export const PLAN_TOOL_SCHEMAS: AnyTool[] = [
  ...READ_TOOL_SCHEMAS,
  ASK_USER_SCHEMA,
  WRITE_PLAN_SCHEMA,
];

// Kept for backwards compatibility with any external consumer.
export const TOOL_SCHEMAS: AnyTool[] = AGENT_TOOL_SCHEMAS;

type ToolHandler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<string>;

export const TOOL_REGISTRY: Record<string, ToolHandler> = {
  read_file: (args) => readFileTool(args as { path: string }),
  list_files: (args) => listFilesTool(args as { path?: string }),
  edit_file: (args) => editFileTool(args as { path: string; content: string }),
  execute_bash: (args, signal) =>
    executeBashTool(args as { command: string }, signal),
  fetch_url: (args, signal) =>
    fetchUrlTool(args as { url: string; max_bytes?: number }, signal),
  write_plan: (args) =>
    writePlanTool(args as { slug: string; title: string; content: string }),
  spawn_background: (args) => spawnBackgroundTool(args as { command: string }),
  list_jobs: () => listJobsTool(),
  read_job_log: (args) =>
    readJobLogTool(args as { job_id: string; tail?: number }),
  kill_job: (args) => killJobTool(args as { job_id: string }),
  list_subagents: () => listSubagentsTool(),
  spawn_subagent: (args) =>
    spawnSubagentTool(args as { agent: string; task: string }),
  subagent_result: (args) =>
    subagentResultTool(args as { job_id: string }),
};

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const handler = TOOL_REGISTRY[name];
  if (!handler) {
    return `Error: unknown tool '${name}'. Available: ${Object.keys(TOOL_REGISTRY).join(", ")}`;
  }
  try {
    return await handler(args, signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error running ${name}: ${msg}`;
  }
}
