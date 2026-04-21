import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import type OpenAI from "openai";

import { WORKSPACE_ROOT, assertInside, relToWorkspace } from "./sandbox.ts";

const MAX_OUTPUT_CHARS = 8000;
const MAX_LIST_ENTRIES = 400;
const LIST_SKIP = new Set(["node_modules", ".git", "dist", ".next", ".turbo"]);

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const head = text.slice(0, MAX_OUTPUT_CHARS);
  const dropped = text.length - MAX_OUTPUT_CHARS;
  return `${head}\n... [truncated, ${dropped} more characters]`;
}

async function readFileTool(args: { path: string }): Promise<string> {
  const abs = assertInside(args.path);
  const content = await fs.readFile(abs, "utf8");
  return truncate(content);
}

async function listFilesTool(args: { path?: string }): Promise<string> {
  const target = args.path && args.path.length > 0 ? args.path : ".";
  const abs = assertInside(target);

  const stat = await fs.stat(abs);
  if (!stat.isDirectory()) {
    throw new Error(`list_files expects a directory, got a file: ${target}`);
  }

  const results: string[] = [];
  const maxDepth = 2;

  async function walk(dir: string, depth: number): Promise<void> {
    if (results.length >= MAX_LIST_ENTRIES) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= MAX_LIST_ENTRIES) return;
      if (LIST_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = relToWorkspace(full);
      if (entry.isDirectory()) {
        results.push(`${rel}/`);
        if (depth < maxDepth) {
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

  const header = `# ${relToWorkspace(abs)} (up to ${MAX_LIST_ENTRIES} entries, depth ${maxDepth})`;
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

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

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

async function fetchUrlTool(args: {
  url: string;
  max_bytes?: number;
}): Promise<string> {
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
      ? Math.min(args.max_bytes, 5_000_000)
      : 500_000;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15_000);

  try {
    const res = await fetch(parsed.toString(), {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": "blackbox-cli-agent/0.1",
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
      throw new Error(`Timeout while fetching ${parsed.toString()} (15s)`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`fetch failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function executeBashTool(args: { command: string }): Promise<string> {
  const command = args.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("execute_bash requires a non-empty 'command' string");
  }

  try {
    const out = execSync(command, {
      cwd: WORKSPACE_ROOT,
      timeout: 30_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PWD: WORKSPACE_ROOT },
      maxBuffer: 10 * 1024 * 1024,
    });
    return truncate(`exit_code: 0\n${out}`);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number | null;
      signal?: string | null;
    };
    const stdout = e.stdout ? e.stdout.toString() : "";
    const stderr = e.stderr ? e.stderr.toString() : "";
    const code = e.status ?? "null";
    const signal = e.signal ? ` signal=${e.signal}` : "";
    const msg = e.message ?? "Unknown error";
    return truncate(
      `exit_code: ${code}${signal}\nerror: ${msg}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
}

type ServerTool = {
  type: `openrouter:${string}`;
  parameters?: Record<string, unknown>;
};

export type AnyTool = OpenAI.Chat.Completions.ChatCompletionTool | ServerTool;

export const TOOL_SCHEMAS: AnyTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a text file from the workspace. Paths are relative to WORKSPACE_ROOT. Long contents are truncated automatically.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file inside the workspace.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    type: "openrouter:web_search",
    parameters: {
      max_results: 5,
      max_total_results: 15,
    },
  },
  {
    type: "openrouter:datetime",
  },
];

type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export const TOOL_REGISTRY: Record<string, ToolHandler> = {
  read_file: (args) => readFileTool(args as { path: string }),
  list_files: (args) => listFilesTool(args as { path?: string }),
  edit_file: (args) => editFileTool(args as { path: string; content: string }),
  execute_bash: (args) => executeBashTool(args as { command: string }),
  fetch_url: (args) => fetchUrlTool(args as { url: string; max_bytes?: number }),
};

export async function runTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const handler = TOOL_REGISTRY[name];
  if (!handler) {
    return `Error: unknown tool '${name}'. Available: ${Object.keys(TOOL_REGISTRY).join(", ")}`;
  }
  try {
    return await handler(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error running ${name}: ${msg}`;
  }
}
