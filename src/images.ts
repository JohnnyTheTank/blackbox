import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const SUPPORTED_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_BYTES_PER_IMAGE = 10 * 1024 * 1024;
const MAX_IMAGES_PER_PROMPT = 8;

export interface ParsedImage {
  /** Data URL (for local files) or http(s) URL (passed through). */
  url: string;
  /** For log output. Either absolute local path or the original URL. */
  displayName: string;
  /** Byte size when known (local files only). */
  bytes?: number;
}

export interface ParseImagesResult {
  /** Prompt text with image tokens removed and whitespace collapsed. */
  text: string;
  images: ParsedImage[];
  /** Human-readable notes for tokens that looked like images but could not be attached. */
  warnings: string[];
}

function hasImageExt(s: string): boolean {
  const lower = s.toLowerCase();
  for (const ext of SUPPORTED_EXTS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function extOf(s: string): string {
  const i = s.lastIndexOf(".");
  return i === -1 ? "" : s.slice(i).toLowerCase();
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Extract candidate tokens from a prompt line:
 *  - "quoted strings" and 'quoted strings'
 *  - backslash-escaped whitespace (drag-and-drop paste)
 *  - bare whitespace-separated tokens
 *
 * Returns tokens together with their [start, end) span in the original text
 * so callers can strip recognized image tokens without corrupting the rest.
 */
interface Token {
  raw: string;
  value: string;
  start: number;
  end: number;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === undefined) break;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let value = "";
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
        } else {
          value += input[i];
          i++;
        }
      }
      if (i < input.length) i++;
      tokens.push({ raw: input.slice(start, i), value, start, end: i });
      continue;
    }
    let value = "";
    while (i < input.length && !/\s/.test(input[i] ?? "")) {
      if (input[i] === "\\" && i + 1 < input.length) {
        value += input[i + 1];
        i += 2;
      } else {
        value += input[i];
        i++;
      }
    }
    tokens.push({ raw: input.slice(start, i), value, start, end: i });
  }
  return tokens;
}

function loadLocalImage(absPath: string): ParsedImage {
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) {
    throw new Error(`not a regular file: ${absPath}`);
  }
  if (stat.size > MAX_BYTES_PER_IMAGE) {
    throw new Error(
      `image too large (${(stat.size / 1024 / 1024).toFixed(1)} MB > 10 MB cap): ${absPath}`,
    );
  }
  const mime = MIME_BY_EXT[extOf(absPath)] ?? "application/octet-stream";
  const buf = fs.readFileSync(absPath);
  const url = `data:${mime};base64,${buf.toString("base64")}`;
  return { url, displayName: absPath, bytes: stat.size };
}

export function parseImages(input: string): ParseImagesResult {
  const tokens = tokenize(input);
  const images: ParsedImage[] = [];
  const warnings: string[] = [];
  const strip: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();

  for (const tok of tokens) {
    const value = tok.value;
    if (value.length === 0) continue;
    if (value.includes("\0")) continue;
    if (!hasImageExt(value)) continue;

    if (/^https?:\/\//i.test(value)) {
      if (images.length >= MAX_IMAGES_PER_PROMPT) {
        warnings.push(`skipped ${value}: reached ${MAX_IMAGES_PER_PROMPT}-image cap`);
        continue;
      }
      if (seen.has(value)) {
        strip.push({ start: tok.start, end: tok.end });
        continue;
      }
      seen.add(value);
      images.push({ url: value, displayName: value });
      strip.push({ start: tok.start, end: tok.end });
      continue;
    }

    const expanded = expandHome(value);
    const abs = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(process.cwd(), expanded);

    if (!fs.existsSync(abs)) continue;

    if (images.length >= MAX_IMAGES_PER_PROMPT) {
      warnings.push(`skipped ${value}: reached ${MAX_IMAGES_PER_PROMPT}-image cap`);
      continue;
    }
    if (seen.has(abs)) {
      strip.push({ start: tok.start, end: tok.end });
      continue;
    }

    try {
      const img = loadLocalImage(abs);
      seen.add(abs);
      images.push(img);
      strip.push({ start: tok.start, end: tok.end });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`skipped ${value}: ${msg}`);
    }
  }

  let text = input;
  if (strip.length > 0) {
    strip.sort((a, b) => b.start - a.start);
    for (const span of strip) {
      text = text.slice(0, span.start) + text.slice(span.end);
    }
    text = text.replace(/\s+/g, " ").trim();
  }

  return { text, images, warnings };
}

/**
 * Dump the macOS clipboard (PNG) to a temp file and return its absolute path.
 * Throws if the platform is not darwin or the clipboard does not contain an image.
 */
export function dumpClipboardImage(): string {
  if (process.platform !== "darwin") {
    throw new Error("/paste is only supported on macOS");
  }
  const outPath = path.join(
    os.tmpdir(),
    `blackbox-clip-${Date.now()}.png`,
  );
  const script = [
    `set outFile to POSIX file "${outPath}"`,
    `try`,
    `  set png_data to (the clipboard as «class PNGf»)`,
    `on error`,
    `  error "no image on clipboard"`,
    `end try`,
    `set fp to open for access outFile with write permission`,
    `try`,
    `  write png_data to fp`,
    `on error err`,
    `  close access fp`,
    `  error err`,
    `end try`,
    `close access fp`,
  ].join("\n");
  try {
    execFileSync("osascript", ["-e", script], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: Buffer | string }).stderr ?? "")
        : "";
    if (/no image on clipboard/i.test(stderr)) {
      throw new Error("clipboard does not contain an image");
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to read clipboard image: ${msg}${stderr ? ` (${stderr.trim()})` : ""}`);
  }
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new Error("clipboard does not contain an image");
  }
  return outPath;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
