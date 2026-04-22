import { DEFAULT_MODEL } from "../config.ts";
import { readPersistedState } from "./state.ts";

export type InitialModelResolution = {
  model: string;
  source: "flag" | "persisted" | "default";
};

export function parseModelFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model" || arg === "-m") {
      return argv[i + 1];
    }
    if (arg && arg.startsWith("--model=")) {
      return arg.slice("--model=".length);
    }
  }
  return undefined;
}

export function resolveInitialModel(): InitialModelResolution {
  const fromFlag = parseModelFlag(process.argv.slice(2));
  if (fromFlag && fromFlag.length > 0) {
    return { model: fromFlag, source: "flag" };
  }
  const persisted = readPersistedState().model;
  if (persisted && persisted.length > 0) {
    return { model: persisted, source: "persisted" };
  }
  return { model: DEFAULT_MODEL, source: "default" };
}
