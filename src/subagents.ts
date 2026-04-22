import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  buildInitialHistory,
  runAgent,
  type AgentReporter,
  type RunAgentOptions,
} from "./agent.ts";
import { ALL_TOOL_NAMES, filterAgentTools } from "./tools.ts";
import { WORKSPACE_ROOT } from "./sandbox.ts";
import {
  appendSubagentLog,
  completeSubagentJob,
  registerSubagentJob,
  type JobRecord,
} from "./jobs.ts";

export type AgentDefinition = {
  name: string;
  description: string;
  tools: string[] | null;
  model: string | null;
  systemPrompt: string;
  source: string;
};

const USER_AGENTS_DIR = path.join(os.homedir(), ".blackbox", "agents");
const PROJECT_AGENTS_DIR = path.join(WORKSPACE_ROOT, ".blackbox", "agents");

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: raw.trim() };
  }
  const [, metaBlock, body] = match;
  const meta: Record<string, string> = {};
  for (const rawLine of (metaBlock ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: (body ?? "").trim() };
}

function parseToolList(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  if (trimmed === "*" || trimmed.toLowerCase() === "all") return null;
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function loadAgentsFromDir(dir: string): { agents: AgentDefinition[]; errors: string[] } {
  const agents: AgentDefinition[] = [];
  const errors: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { agents, errors };
    errors.push(`Failed to read ${dir}: ${(err as Error).message}`);
    return { agents, errors };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const absPath = path.join(dir, entry.name);
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, "utf8");
    } catch (err) {
      errors.push(`${absPath}: ${(err as Error).message}`);
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    const name = (meta.name ?? entry.name.replace(/\.md$/, "")).trim();
    if (name.length === 0) {
      errors.push(`${absPath}: missing 'name' in frontmatter`);
      continue;
    }
    if (body.length === 0) {
      errors.push(`${absPath}: missing system prompt body`);
      continue;
    }
    const tools = parseToolList(meta.tools);

    if (tools !== null) {
      const known = new Set(ALL_TOOL_NAMES);
      const invalid = tools.filter((t) => !known.has(t));
      if (invalid.length > 0) {
        errors.push(
          `${absPath}: unknown tool(s) in 'tools': ${invalid.join(", ")}. Available: ${ALL_TOOL_NAMES.join(", ")}`,
        );
        continue;
      }
    }

    agents.push({
      name,
      description: (meta.description ?? "").trim(),
      tools,
      model: meta.model ? meta.model.trim() : null,
      systemPrompt: body,
      source: absPath,
    });
  }

  return { agents, errors };
}

export type AgentRegistry = {
  agents: Map<string, AgentDefinition>;
  errors: string[];
};

export function loadAgents(): AgentRegistry {
  const merged = new Map<string, AgentDefinition>();
  const errors: string[] = [];

  const user = loadAgentsFromDir(USER_AGENTS_DIR);
  errors.push(...user.errors);
  for (const a of user.agents) merged.set(a.name, a);

  const project = loadAgentsFromDir(PROJECT_AGENTS_DIR);
  errors.push(...project.errors);
  for (const a of project.agents) merged.set(a.name, a);

  return { agents: merged, errors };
}

let cachedRegistry: AgentRegistry | null = null;

export function getAgentRegistry(reload = false): AgentRegistry {
  if (reload || !cachedRegistry) {
    cachedRegistry = loadAgents();
  }
  return cachedRegistry;
}

export function listAgents(): AgentDefinition[] {
  const reg = getAgentRegistry();
  return Array.from(reg.agents.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function getAgent(name: string): AgentDefinition | undefined {
  return getAgentRegistry().agents.get(name);
}

export type SpawnSubagentOptions = {
  fallbackModel: string;
};

export function spawnSubagentJob(
  agentName: string,
  task: string,
  options: SpawnSubagentOptions,
): { job: JobRecord } | { error: string } {
  const agent = getAgent(agentName);
  if (!agent) {
    const known = listAgents()
      .map((a) => a.name)
      .join(", ");
    return {
      error: `Unknown subagent '${agentName}'. Known agents: ${known.length > 0 ? known : "(none loaded)"}.`,
    };
  }
  if (typeof task !== "string" || task.trim().length === 0) {
    return { error: "spawn_subagent requires a non-empty 'task' string" };
  }

  const abort = new AbortController();
  const label = `${agent.name}: ${task.slice(0, 80)}${task.length > 80 ? "…" : ""}`;
  const job = registerSubagentJob(label, abort);

  appendSubagentLog(job.id, `[agent] ${agent.name}`);
  appendSubagentLog(job.id, `[model] ${agent.model ?? options.fallbackModel}`);
  appendSubagentLog(
    job.id,
    `[tools] ${agent.tools === null ? "(all)" : agent.tools.join(", ") || "(none)"}`,
  );
  appendSubagentLog(job.id, `[task] ${task}`);
  appendSubagentLog(job.id, "");

  const allowedSet: Set<string> | null =
    agent.tools === null ? null : new Set(agent.tools);
  const tools = filterAgentTools(allowedSet);

  const reporter: AgentReporter = {
    onToolCall: (name, args) => {
      appendSubagentLog(job.id, `→ ${name}(${args})`);
    },
    onToolResult: (name, result) => {
      const firstLine = result.split("\n", 1)[0] ?? "";
      const shortPreview =
        firstLine.length > 240 ? `${firstLine.slice(0, 240)}…` : firstLine;
      appendSubagentLog(job.id, `  ← ${name} ${shortPreview}`);
    },
  };

  const history = buildInitialHistory(agent.systemPrompt);
  const model = agent.model ?? options.fallbackModel;
  const runOptions: RunAgentOptions = {
    tools,
  };

  void (async () => {
    try {
      const { answer } = await runAgent(
        history,
        task,
        model,
        reporter,
        abort.signal,
        runOptions,
      );
      if (abort.signal.aborted) {
        completeSubagentJob(job.id, answer ?? "", "cancelled");
      } else {
        appendSubagentLog(job.id, "");
        appendSubagentLog(job.id, "[result]");
        appendSubagentLog(job.id, answer ?? "(empty)");
        completeSubagentJob(job.id, answer ?? "", "done");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (abort.signal.aborted) {
        completeSubagentJob(job.id, "", "cancelled", msg);
      } else {
        completeSubagentJob(job.id, "", "error", msg);
      }
    }
  })();

  return { job };
}

export function listAgentsForDisplay(): string {
  const agents = listAgents();
  if (agents.length === 0) {
    return `No subagents configured. Drop markdown files into ${PROJECT_AGENTS_DIR} or ${USER_AGENTS_DIR}.`;
  }
  const lines = agents.map((a) => {
    const toolInfo =
      a.tools === null ? "all tools" : `tools: ${a.tools.join(", ") || "(none)"}`;
    const modelInfo = a.model ?? "(inherits main model)";
    const desc = a.description.length > 0 ? ` — ${a.description}` : "";
    return `- ${a.name}${desc}\n    model: ${modelInfo}\n    ${toolInfo}`;
  });
  return lines.join("\n");
}

export const AGENTS_DIRS = {
  user: USER_AGENTS_DIR,
  project: PROJECT_AGENTS_DIR,
};
