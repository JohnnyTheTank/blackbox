import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { WORKSPACE_ROOT } from "./sandbox.ts";
import { PLANS_DIR, PLAN_FILE_SUFFIX } from "./config.ts";

export type PromptName = "agent" | "plan";

// src/prompts.ts lives directly inside <install>/src/, so the install
// directory is one level up. This is where the builtin defaults live.
const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BUILTIN_PROMPTS_DIR = path.join(INSTALL_DIR, "prompts");
const USER_PROMPTS_DIR = path.join(os.homedir(), ".blackbox", "prompts");
const PROJECT_PROMPTS_DIR = path.join(WORKSPACE_ROOT, ".blackbox", "prompts");

const FILENAMES: Record<PromptName, string> = {
  agent: "agent.md",
  plan: "plan.md",
};

export const PROMPT_NAMES: PromptName[] = ["agent", "plan"];

export const PROMPTS_DIRS = {
  builtin: BUILTIN_PROMPTS_DIR,
  user: USER_PROMPTS_DIR,
  project: PROJECT_PROMPTS_DIR,
};

export type PromptSource = "project" | "user" | "builtin";

export type PromptResolution = {
  name: PromptName;
  path: string;
  source: PromptSource;
  content: string;
};

function substitutePlaceholders(raw: string): string {
  return raw
    .replace(/\{\{\s*WORKSPACE_ROOT\s*\}\}/g, WORKSPACE_ROOT)
    .replace(/\{\{\s*PLANS_DIR\s*\}\}/g, PLANS_DIR)
    .replace(/\{\{\s*PLAN_FILE_SUFFIX\s*\}\}/g, PLAN_FILE_SUFFIX);
}

function tryReadFile(file: string): string | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw.replace(/\s+$/u, "");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Resolve a prompt by walking the override chain:
 *   1. <workspace>/.blackbox/prompts/<name>.md   (project)
 *   2. ~/.blackbox/prompts/<name>.md             (user)
 *   3. <install>/prompts/<name>.md               (builtin, shipped)
 *
 * The file is re-read from disk on every call so edits take effect
 * immediately the next time a fresh conversation is started.
 */
export function resolvePrompt(name: PromptName): PromptResolution {
  const fname = FILENAMES[name];
  const candidates: Array<[string, PromptSource]> = [
    [path.join(PROJECT_PROMPTS_DIR, fname), "project"],
    [path.join(USER_PROMPTS_DIR, fname), "user"],
    [path.join(BUILTIN_PROMPTS_DIR, fname), "builtin"],
  ];

  for (const [file, source] of candidates) {
    const raw = tryReadFile(file);
    if (raw !== null) {
      if (raw.trim().length === 0) continue;
      return {
        name,
        path: file,
        source,
        content: substitutePlaceholders(raw),
      };
    }
  }

  throw new Error(
    `Missing built-in prompt '${name}'. Expected file at ${path.join(BUILTIN_PROMPTS_DIR, fname)}. ` +
    `Reinstall blackbox or restore the prompts/ directory.`,
  );
}

export function loadSystemPrompt(name: PromptName): string {
  return resolvePrompt(name).content;
}

export function listPromptResolutions(): PromptResolution[] {
  return PROMPT_NAMES.map((n) => resolvePrompt(n));
}

/**
 * Copy the builtin prompts to `<workspace>/.blackbox/prompts/` so the
 * user can edit them. Existing files are never overwritten; returns a
 * report describing which files were created/skipped.
 */
export type InitResult = {
  dir: string;
  created: string[];
  skipped: string[];
  errors: string[];
};

export function initProjectPrompts(): InitResult {
  const dir = PROJECT_PROMPTS_DIR;
  const created: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    errors.push(`Failed to create ${dir}: ${(err as Error).message}`);
    return { dir, created, skipped, errors };
  }

  for (const name of PROMPT_NAMES) {
    const fname = FILENAMES[name];
    const target = path.join(dir, fname);
    if (fs.existsSync(target)) {
      skipped.push(target);
      continue;
    }
    const source = path.join(BUILTIN_PROMPTS_DIR, fname);
    try {
      const raw = fs.readFileSync(source, "utf8");
      fs.writeFileSync(target, raw, "utf8");
      created.push(target);
    } catch (err) {
      errors.push(`${target}: ${(err as Error).message}`);
    }
  }

  return { dir, created, skipped, errors };
}
