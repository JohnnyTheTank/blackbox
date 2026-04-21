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

export const TOOL_SCHEMAS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
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
];

type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export const TOOL_REGISTRY: Record<string, ToolHandler> = {
  read_file: (args) => readFileTool(args as { path: string }),
  list_files: (args) => listFilesTool(args as { path?: string }),
  edit_file: (args) => editFileTool(args as { path: string; content: string }),
  execute_bash: (args) => executeBashTool(args as { command: string }),
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
