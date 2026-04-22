import {
  TOOL_OUTPUT_MAX_CHARS,
  TOOL_PREVIEW_MAX_CHARS,
  TOOL_PREVIEW_MAX_LINES,
  TOOL_LIST_ARG_PREVIEW_MAX,
} from "../config.ts";
import { C } from "./colors.ts";

export function truncate(text: string, options?: { hint?: string }): string {
  if (text.length <= TOOL_OUTPUT_MAX_CHARS) return text;
  const head = text.slice(0, TOOL_OUTPUT_MAX_CHARS);
  const dropped = text.length - TOOL_OUTPUT_MAX_CHARS;
  const hint = options?.hint ? ` — ${options.hint}` : "";
  return `${head}\n... [truncated, ${dropped} more characters${hint}]`;
}

export function shortenArgs(raw: string, max: number = TOOL_LIST_ARG_PREVIEW_MAX): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

export function previewResult(result: string): string {
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

export function prettyJson(raw: string): string {
  if (raw.trim().length === 0) return "(no args)";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function formatToolCallLine(name: string, args: string): string {
  return C.dim(`  → ${name}(${args})`);
}

export function formatToolPreviewBlock(result: string): string {
  const preview = previewResult(result);
  if (preview.length === 0) return C.dim("    (empty result)");
  return preview
    .split("\n")
    .map((line) => C.dim(`    ${line}`))
    .join("\n");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatRuntime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm.toString().padStart(2, "0")}m`;
}
