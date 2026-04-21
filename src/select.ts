import * as readline from "node:readline";
import { stdin, stdout } from "node:process";

export type SelectOption<T> = {
  label: string;
  hint?: string;
  value: T;
  disabled?: boolean;
};

export type SelectConfig<T> = {
  title?: string;
  options: SelectOption<T>[];
  initialIndex?: number;
  pageSize?: number;
  helpHint?: string;
  actionKeys?: string[];
};

export type SelectResult<T> =
  | { type: "select"; value: T }
  | { type: "action"; key: string; value: T };

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
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

/**
 * Interactive single-select picker using arrow keys + Enter/Space.
 *
 * Falls back to a plain print-and-return-undefined when stdout is not a TTY,
 * so piped/CI invocations stay unaffected.
 *
 * Navigation:
 *   ↑/k, ↓/j       move cursor
 *   PageUp/Down    jump by page
 *   Home/End       jump to edges
 *   Enter/Space    confirm selection
 *   Esc/q/Ctrl-C   cancel (returns undefined)
 */
export async function selectFromList<T>(
  cfg: SelectConfig<T>,
): Promise<T | undefined> {
  const result = await selectFromListEx(cfg);
  if (!result) return undefined;
  if (result.type === "select") return result.value;
  return undefined;
}

export async function selectFromListEx<T>(
  cfg: SelectConfig<T>,
): Promise<SelectResult<T> | undefined> {
  const options = cfg.options;
  if (options.length === 0) return undefined;
  const actionKeys = new Set((cfg.actionKeys ?? []).map((k) => k.toLowerCase()));

  const isTTY = Boolean(stdout.isTTY) && Boolean(stdin.isTTY);
  if (!isTTY) {
    if (cfg.title) stdout.write(cfg.title + "\n");
    for (const opt of options) {
      const hint = opt.hint ? `  ${opt.hint}` : "";
      stdout.write(`  ${opt.label}${hint}\n`);
    }
    return undefined;
  }

  const pageSize = Math.max(
    3,
    Math.min(cfg.pageSize ?? 12, options.length),
  );

  let cursor = clamp(cfg.initialIndex ?? 0, 0, options.length - 1);
  if (options[cursor]?.disabled) {
    cursor = findNextEnabled(options, cursor, 1) ?? cursor;
  }
  let viewTop = clampViewTop(cursor, pageSize, options.length, 0);
  let rowsRendered = 0;

  const wasRaw = stdin.isRaw === true;
  const wasPaused = stdin.isPaused();
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  if (wasPaused) stdin.resume();
  stdout.write(HIDE_CURSOR);

  const render = (): void => {
    if (rowsRendered > 0) {
      stdout.write(`\r${ESC}[${rowsRendered - 1}A`);
      for (let i = 0; i < rowsRendered; i++) {
        stdout.write(`${ESC}[2K`);
        if (i < rowsRendered - 1) stdout.write(`${ESC}[1B`);
      }
      stdout.write(`\r${ESC}[${rowsRendered - 1}A`);
    }

    const lines: string[] = [];
    if (cfg.title) lines.push(C.bold(cfg.title));

    const viewEnd = Math.min(options.length, viewTop + pageSize);
    if (viewTop > 0) {
      lines.push(C.dim(`  ↑ ${viewTop} more…`));
    }
    for (let i = viewTop; i < viewEnd; i++) {
      const opt = options[i]!;
      const selected = i === cursor;
      const prefix = selected ? C.cyan("›") : " ";
      const hint = opt.hint ? ` ${C.dim(opt.hint)}` : "";
      let label = opt.label;
      if (opt.disabled) label = C.dim(label);
      else if (selected) label = C.bold(C.cyan(label));
      lines.push(`${prefix} ${label}${hint}`);
    }
    if (viewEnd < options.length) {
      lines.push(C.dim(`  ↓ ${options.length - viewEnd} more…`));
    }
    lines.push(
      C.dim(
        cfg.helpHint ??
        "  ↑↓ move · Enter/Space select · Esc cancel",
      ),
    );

    stdout.write(lines.join("\n"));
    rowsRendered = lines.length;
  };

  const cleanup = (): void => {
    if (rowsRendered > 0) {
      stdout.write(`\r${ESC}[${rowsRendered - 1}A`);
      for (let i = 0; i < rowsRendered; i++) {
        stdout.write(`${ESC}[2K`);
        if (i < rowsRendered - 1) stdout.write(`${ESC}[1B`);
      }
      stdout.write(`\r${ESC}[${rowsRendered - 1}A`);
    }
    stdout.write(SHOW_CURSOR);
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      // ignore
    }
    if (wasPaused) stdin.pause();
  };

  render();

  return new Promise<SelectResult<T> | undefined>((resolve) => {
    let finished = false;

    const onKeypress = (_str: string | undefined, key: Key | undefined): void => {
      if (finished) return;
      if (!key) return;

      const move = (delta: number): void => {
        const next = findNextEnabled(options, cursor, delta);
        if (next == null) return;
        cursor = next;
        viewTop = clampViewTop(cursor, pageSize, options.length, viewTop);
        render();
      };

      if (key.ctrl && key.name === "c") {
        return finish(undefined);
      }

      const keyName = key.name?.toLowerCase();
      if (keyName && actionKeys.has(keyName)) {
        const picked = options[cursor];
        if (!picked || picked.disabled) return;
        return finish({ type: "action", key: keyName, value: picked.value });
      }

      switch (key.name) {
        case "up":
          return move(-1);
        case "down":
          return move(1);
        case "k":
          if (actionKeys.has("k")) return;
          return move(-1);
        case "j":
          if (actionKeys.has("j")) return;
          return move(1);
        case "pageup":
          return move(-pageSize);
        case "pagedown":
          return move(pageSize);
        case "home":
          cursor = firstEnabled(options) ?? cursor;
          viewTop = clampViewTop(cursor, pageSize, options.length, viewTop);
          return render();
        case "end":
          cursor = lastEnabled(options) ?? cursor;
          viewTop = clampViewTop(cursor, pageSize, options.length, viewTop);
          return render();
        case "escape":
          return finish(undefined);
        case "q":
          if (actionKeys.has("q")) return;
          return finish(undefined);
        case "return":
        case "space":
        case "enter": {
          const picked = options[cursor];
          if (!picked || picked.disabled) return;
          return finish({ type: "select", value: picked.value });
        }
        default:
          return;
      }
    };

    const finish = (value: SelectResult<T> | undefined): void => {
      if (finished) return;
      finished = true;
      stdin.off("keypress", onKeypress);
      cleanup();
      resolve(value);
    };

    stdin.on("keypress", onKeypress);
  });
}

function clamp(n: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, n));
}

function clampViewTop(
  cursor: number,
  pageSize: number,
  total: number,
  prev: number,
): number {
  let top = prev;
  if (cursor < top) top = cursor;
  if (cursor >= top + pageSize) top = cursor - pageSize + 1;
  const maxTop = Math.max(0, total - pageSize);
  return Math.max(0, Math.min(top, maxTop));
}

function findNextEnabled<T>(
  options: SelectOption<T>[],
  from: number,
  delta: number,
): number | undefined {
  if (options.length === 0) return undefined;
  const step = delta > 0 ? 1 : -1;
  const remaining = Math.abs(delta);
  let idx = from;
  for (let moved = 0; moved < remaining; moved++) {
    let next = idx + step;
    while (next >= 0 && next < options.length && options[next]?.disabled) {
      next += step;
    }
    if (next < 0 || next >= options.length) break;
    idx = next;
  }
  return idx === from && options[from]?.disabled ? undefined : idx;
}

function firstEnabled<T>(options: SelectOption<T>[]): number | undefined {
  for (let i = 0; i < options.length; i++) {
    if (!options[i]?.disabled) return i;
  }
  return undefined;
}

function lastEnabled<T>(options: SelectOption<T>[]): number | undefined {
  for (let i = options.length - 1; i >= 0; i--) {
    if (!options[i]?.disabled) return i;
  }
  return undefined;
}

export { C as SelectColors };
