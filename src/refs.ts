import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  LIST_MAX_DEPTH,
  LIST_MAX_ENTRIES,
  LIST_SKIP,
  REFS_MAX_CONTENT_CHARS,
  REFS_MAX_PER_PROMPT,
  REFS_MAX_SCAN_ENTRIES,
  TOOL_OUTPUT_MAX_CHARS,
} from "./config.ts";
import { WORKSPACE_ROOT } from "./sandbox.ts";

export interface RefEntry {
  /** Workspace-relative path with forward slashes. Directories end with '/'. */
  relPath: string;
  /** Absolute path. */
  absPath: string;
  isDirectory: boolean;
}

export interface ResolvedRef {
  relPath: string;
  kind: "file" | "folder";
  content: string;
  /** Additional metadata shown in the header (e.g. size, listing). */
  note: string;
}

export interface ResolveRefsResult {
  /** Original input with all resolved @tokens left as-is (they are informative). */
  text: string;
  refs: ResolvedRef[];
  warnings: string[];
}

let cache: RefEntry[] | null = null;
let scanning: Promise<RefEntry[]> | null = null;

export function invalidateCache(): void {
  cache = null;
  scanning = null;
}

function normalizeRel(rel: string): string {
  return rel.split(path.sep).join("/");
}

async function walk(
  absDir: string,
  relDir: string,
  out: RefEntry[],
): Promise<void> {
  if (out.length >= REFS_MAX_SCAN_ENTRIES) return;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= REFS_MAX_SCAN_ENTRIES) return;
    if (entry.name.startsWith(".")) continue;
    if (LIST_SKIP.has(entry.name)) continue;
    const abs = path.join(absDir, entry.name);
    const rel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push({
        relPath: `${normalizeRel(rel)}/`,
        absPath: abs,
        isDirectory: true,
      });
      await walk(abs, rel, out);
    } else if (entry.isFile()) {
      out.push({
        relPath: normalizeRel(rel),
        absPath: abs,
        isDirectory: false,
      });
    }
  }
}

export async function scanWorkspace(force = false): Promise<RefEntry[]> {
  if (!force && cache) return cache;
  if (!force && scanning) return scanning;
  scanning = (async () => {
    const out: RefEntry[] = [];
    await walk(WORKSPACE_ROOT, "", out);
    cache = out;
    scanning = null;
    return out;
  })();
  return scanning;
}

export function getCachedEntries(): RefEntry[] | null {
  return cache;
}

const REF_TOKEN_RE = /(^|\s)@([^\s@][^\s]*)/g;

export interface RefToken {
  raw: string;
  relPath: string;
  start: number;
  end: number;
}

export function extractRefTokens(input: string): RefToken[] {
  const tokens: RefToken[] = [];
  REF_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_TOKEN_RE.exec(input)) !== null) {
    const prefix = m[1] ?? "";
    const pathPart = m[2] ?? "";
    if (pathPart.length === 0) continue;
    const atStart = m.index + prefix.length;
    const end = atStart + 1 + pathPart.length;
    tokens.push({
      raw: `@${pathPart}`,
      relPath: stripTrailingPunctuation(pathPart),
      start: atStart,
      end,
    });
  }
  return tokens;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[)\]},.;:!?]+$/u, "");
}

function isInsideWorkspace(absPath: string): boolean {
  const rel = path.relative(WORKSPACE_ROOT, absPath);
  if (rel.length === 0) return true;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

async function folderListing(absDir: string, relDir: string): Promise<string> {
  const results: string[] = [];
  async function walkListing(dir: string, depth: number): Promise<void> {
    if (results.length >= LIST_MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= LIST_MAX_ENTRIES) return;
      if (LIST_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(WORKSPACE_ROOT, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        results.push(`${rel}/`);
        if (depth < LIST_MAX_DEPTH) {
          await walkListing(full, depth + 1);
        }
      } else if (entry.isFile()) {
        results.push(rel);
      } else if (entry.isSymbolicLink()) {
        results.push(`${rel} (symlink)`);
      }
    }
  }
  await walkListing(absDir, 1);
  const header = `# ${relDir.length === 0 ? "." : relDir} (up to ${LIST_MAX_ENTRIES} entries, depth ${LIST_MAX_DEPTH})`;
  const body = results.length > 0 ? results.join("\n") : "(empty)";
  return `${header}\n${body}`;
}

function truncateContent(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, cap);
  const dropped = text.length - cap;
  return `${head}\n... [truncated, ${dropped} more characters]`;
}

export async function resolveRefs(input: string): Promise<ResolveRefsResult> {
  const tokens = extractRefTokens(input);
  const refs: ResolvedRef[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const tok of tokens) {
    const relRaw = tok.relPath;
    if (relRaw.length === 0) continue;

    if (refs.length >= REFS_MAX_PER_PROMPT) {
      warnings.push(
        `skipped ${tok.raw}: reached ${REFS_MAX_PER_PROMPT}-reference cap`,
      );
      continue;
    }

    const trimmed = relRaw.replace(/\/+$/u, "");
    if (trimmed.length === 0) continue;

    const abs = path.resolve(WORKSPACE_ROOT, trimmed);
    if (!isInsideWorkspace(abs)) {
      warnings.push(`skipped ${tok.raw}: path escapes workspace`);
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(abs);
    } catch {
      warnings.push(`skipped ${tok.raw}: not found in workspace`);
      continue;
    }

    const relFromRoot = path
      .relative(WORKSPACE_ROOT, abs)
      .split(path.sep)
      .join("/");
    const dedupeKey = stat.isDirectory() ? `${relFromRoot}/` : relFromRoot;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (stat.isDirectory()) {
      try {
        const listing = await folderListing(abs, relFromRoot);
        refs.push({
          relPath: `${relFromRoot}/`,
          kind: "folder",
          content: truncateContent(listing, TOOL_OUTPUT_MAX_CHARS),
          note: "folder listing",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`skipped ${tok.raw}: ${msg}`);
      }
      continue;
    }

    if (stat.isFile()) {
      try {
        const raw = await fsp.readFile(abs, "utf8");
        const content = truncateContent(raw, REFS_MAX_CONTENT_CHARS);
        refs.push({
          relPath: relFromRoot,
          kind: "file",
          content,
          note: `${stat.size} bytes`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`skipped ${tok.raw}: ${msg}`);
      }
      continue;
    }

    warnings.push(`skipped ${tok.raw}: not a regular file or directory`);
  }

  return { text: input, refs, warnings };
}

export function formatRefsBlock(refs: ResolvedRef[]): string {
  if (refs.length === 0) return "";
  const parts: string[] = ["Referenced by the user:"];
  for (const ref of refs) {
    const header =
      ref.kind === "file"
        ? `@${ref.relPath} (file, ${ref.note})`
        : `@${ref.relPath} (${ref.note})`;
    parts.push("");
    parts.push(header);
    parts.push("```");
    parts.push(ref.content.length > 0 ? ref.content : "(empty)");
    parts.push("```");
  }
  return parts.join("\n");
}
