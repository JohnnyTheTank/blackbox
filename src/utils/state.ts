import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const STATE_PATH = join(INSTALL_DIR, ".blackbox-state.json");

export type PersistedState = {
  model?: string;
};

export function readPersistedState(): PersistedState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as PersistedState;
    }
    return {};
  } catch {
    return {};
  }
}

export function writePersistedState(state: PersistedState): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // persistence is best-effort; ignore write failures
  }
}

export function persistModel(model: string): void {
  const state = readPersistedState();
  if (state.model === model) return;
  state.model = model;
  writePersistedState(state);
}
