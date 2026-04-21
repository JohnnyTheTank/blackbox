import * as readline from "node:readline";
import { stdin, stdout } from "node:process";

import {
  REFS_PICKER_MAX_RESULTS,
  REFS_PICKER_PAGE_SIZE,
} from "./config.ts";
import { fuzzyRank, scanWorkspace, type RefEntry } from "./refs.ts";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

type Key = {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
};

export interface PickPathOptions {
  title?: string;
  initialQuery?: string;
  pageSize?: number;
}

export interface PickedPath {
  relPath: string;
  isDirectory: boolean;
}

function isTypableChar(ch: string | undefined): boolean {
  if (!ch || ch.length !== 1) return false;
  return /^[A-Za-z0-9._\-/@ ]$/.test(ch);
}

/**
 * Interactive filter-as-you-type picker over workspace files and folders.
 * Returns `undefined` on cancel. No-op on non-TTY (returns undefined without
 * rendering).
 */
export async function pickPath(
  opts: PickPathOptions = {},
): Promise<PickedPath | undefined> {
  const isTTY = Boolean(stdout.isTTY) && Boolean(stdin.isTTY);
  if (!isTTY) return undefined;

  const entries = await scanWorkspace();
  if (entries.length === 0) return undefined;

  const pageSize = Math.max(3, opts.pageSize ?? REFS_PICKER_PAGE_SIZE);
  const title = opts.title ?? "Pick a file or folder";

  let query = opts.initialQuery ?? "";
  let cursor = 0;
  let viewTop = 0;
  let rowsRendered = 0;

  let ranked = computeRanked(entries, query);

  const wasRaw = stdin.isRaw === true;
  const wasPaused = stdin.isPaused();
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  if (wasPaused) stdin.resume();
  stdout.write(HIDE_CURSOR);

  const clearRendered = (): void => {
    if (rowsRendered > 0) {
      stdout.write(`\r${ESC}[${rowsRendered - 1}A`);
      for (let i = 0; i < rowsRendered; i++) {
        stdout.write(`${ESC}[2K`);
        if (i < rowsRendered - 1) stdout.write(`${ESC}[1B`);
      }
      stdout.write(`\r${ESC}[${rowsRendered - 1}A`);
    }
  };

  const render = (): void => {
    clearRendered();

    const total = ranked.length;
    if (cursor >= total) cursor = Math.max(0, total - 1);
    if (cursor < viewTop) viewTop = cursor;
    const maxTop = Math.max(0, total - pageSize);
    if (cursor >= viewTop + pageSize) viewTop = cursor - pageSize + 1;
    if (viewTop > maxTop) viewTop = maxTop;
    if (viewTop < 0) viewTop = 0;

    const lines: string[] = [];
    lines.push(C.bold(title));
    const queryLine =
      query.length === 0
        ? C.dim("  query: (type to filter)")
        : `  ${C.dim("query:")} ${query}${C.dim("_")}`;
    lines.push(queryLine);

    if (total === 0) {
      lines.push(C.yellow("  (no matches)"));
    } else {
      const viewEnd = Math.min(total, viewTop + pageSize);
      if (viewTop > 0) {
        lines.push(C.dim(`  ↑ ${viewTop} more…`));
      }
      for (let i = viewTop; i < viewEnd; i++) {
        const entry = ranked[i]!;
        const selected = i === cursor;
        const prefix = selected ? C.cyan("›") : " ";
        const kindMark = entry.isDirectory ? C.dim("(dir)") : C.dim("     ");
        const label = selected
          ? C.bold(C.cyan(entry.relPath))
          : entry.relPath;
        lines.push(`${prefix} ${kindMark} ${label}`);
      }
      if (viewEnd < total) {
        lines.push(C.dim(`  ↓ ${total - viewEnd} more…`));
      }
    }
    lines.push(
      C.dim("  ↑↓ move · Enter select · Backspace edit · Esc cancel"),
    );

    stdout.write(lines.join("\n"));
    rowsRendered = lines.length;
  };

  const cleanup = (): void => {
    clearRendered();
    stdout.write(SHOW_CURSOR);
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      // ignore
    }
    if (wasPaused) stdin.pause();
  };

  render();

  return new Promise<PickedPath | undefined>((resolve) => {
    let finished = false;

    const finish = (value: PickedPath | undefined): void => {
      if (finished) return;
      finished = true;
      stdin.off("keypress", onKeypress);
      cleanup();
      resolve(value);
    };

    const refilter = (): void => {
      ranked = computeRanked(entries, query);
      cursor = 0;
      viewTop = 0;
      render();
    };

    const move = (delta: number): void => {
      if (ranked.length === 0) return;
      let next = cursor + delta;
      if (next < 0) next = 0;
      if (next >= ranked.length) next = ranked.length - 1;
      if (next === cursor) return;
      cursor = next;
      render();
    };

    const onKeypress = (
      str: string | undefined,
      key: Key | undefined,
    ): void => {
      if (finished) return;
      if (!key) return;

      if (key.ctrl && key.name === "c") {
        return finish(undefined);
      }

      switch (key.name) {
        case "up":
          return move(-1);
        case "down":
          return move(1);
        case "pageup":
          return move(-pageSize);
        case "pagedown":
          return move(pageSize);
        case "home":
          cursor = 0;
          viewTop = 0;
          return render();
        case "end":
          cursor = Math.max(0, ranked.length - 1);
          return render();
        case "escape":
          return finish(undefined);
        case "return":
        case "enter": {
          const picked = ranked[cursor];
          if (!picked) return;
          return finish({
            relPath: picked.relPath,
            isDirectory: picked.isDirectory,
          });
        }
        case "backspace":
          if (query.length > 0) {
            query = query.slice(0, -1);
            refilter();
          }
          return;
        case "tab":
          return;
        default: {
          const ch = str ?? key.sequence;
          if (isTypableChar(ch) && !key.ctrl && !key.meta) {
            query += ch;
            refilter();
          }
          return;
        }
      }
    };

    stdin.on("keypress", onKeypress);
  });
}

function computeRanked(entries: RefEntry[], query: string): RefEntry[] {
  const ranked = fuzzyRank(entries, query, REFS_PICKER_MAX_RESULTS);
  return ranked.map((r) => r.entry);
}
