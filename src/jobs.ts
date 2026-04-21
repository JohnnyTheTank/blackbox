import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { WORKSPACE_ROOT } from "./sandbox.ts";

export type JobKind = "shell" | "subagent";
export type JobStatus = "running" | "done" | "error" | "cancelled";

export type JobRecord = {
  id: string;
  kind: JobKind;
  label: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  logPath: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  result?: string;
  error?: string;
  child?: ChildProcess;
  abort?: AbortController;
};

export type JobSummary = {
  id: string;
  kind: JobKind;
  label: string;
  status: JobStatus;
  runtimeMs: number;
  exitCode?: number | null;
};

const JOB_LOG_MAX_BYTES = 10 * 1024 * 1024;
const JOB_LOG_TAIL_LINES_DEFAULT = 200;
const JOB_LOG_TAIL_LINES_MAX = 5000;

const registry = new Map<string, JobRecord>();
let nextJobId = 1;
let tmpDir: string | null = null;
let cleanupRegistered = false;

function getTmpDir(): string {
  if (tmpDir) return tmpDir;
  const base = path.join(os.tmpdir(), `blackbox-${process.pid}`);
  fs.mkdirSync(base, { recursive: true });
  tmpDir = base;

  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on("exit", () => {
      try {
        fs.rmSync(base, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
  }
  return tmpDir;
}

function makeJobId(kind: JobKind): string {
  const id = `${kind === "shell" ? "sh" : "sa"}_${nextJobId++}`;
  return id;
}

function makeLogPath(id: string): string {
  return path.join(getTmpDir(), `${id}.log`);
}

function appendLog(record: JobRecord, chunk: string | Buffer): void {
  const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
  try {
    const stat = fs.existsSync(record.logPath)
      ? fs.statSync(record.logPath)
      : null;
    const currentSize = stat?.size ?? 0;
    if (currentSize >= JOB_LOG_MAX_BYTES) return;
    const remaining = JOB_LOG_MAX_BYTES - currentSize;
    const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
    fs.appendFileSync(record.logPath, slice);
    if (slice.length < buf.length) {
      fs.appendFileSync(
        record.logPath,
        Buffer.from(
          `\n[log capped at ${JOB_LOG_MAX_BYTES} bytes]\n`,
          "utf8",
        ),
      );
    }
  } catch {
    // best-effort
  }
}

function ensureLogFile(record: JobRecord): void {
  try {
    fs.writeFileSync(record.logPath, "", "utf8");
  } catch {
    // best-effort
  }
}

function killProcessGroup(
  child: ChildProcess,
  sig: NodeJS.Signals = "SIGTERM",
): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}

export function spawnShellJob(command: string): JobRecord {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("spawn_background requires a non-empty 'command' string");
  }

  const id = makeJobId("shell");
  const logPath = makeLogPath(id);

  const record: JobRecord = {
    id,
    kind: "shell",
    label: command,
    status: "running",
    startedAt: Date.now(),
    logPath,
  };
  ensureLogFile(record);
  appendLog(record, `$ ${command}\n`);

  const child = spawn(command, {
    cwd: WORKSPACE_ROOT,
    shell: true,
    env: { ...process.env, PWD: WORKSPACE_ROOT },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  record.child = child;

  child.stdout?.on("data", (chunk: Buffer) => {
    appendLog(record, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    appendLog(record, chunk);
  });

  child.on("error", (err: Error) => {
    if (record.status !== "running") return;
    record.status = "error";
    record.error = err.message;
    record.endedAt = Date.now();
    appendLog(record, `\n[error: ${err.message}]\n`);
  });

  child.on(
    "close",
    (code: number | null, sigName: NodeJS.Signals | null) => {
      if (record.status !== "running") return;
      record.endedAt = Date.now();
      record.exitCode = code;
      record.signal = sigName;
      if (sigName && code === null) {
        record.status = "cancelled";
        appendLog(record, `\n[terminated by signal ${sigName}]\n`);
      } else if (code === 0) {
        record.status = "done";
        appendLog(record, `\n[exit 0]\n`);
      } else {
        record.status = "error";
        record.error = `exit code ${code ?? "null"}${sigName ? ` signal=${sigName}` : ""}`;
        appendLog(
          record,
          `\n[exit ${code ?? "null"}${sigName ? ` signal=${sigName}` : ""}]\n`,
        );
      }
    },
  );

  registry.set(id, record);
  return record;
}

export function registerSubagentJob(
  label: string,
  abort: AbortController,
): JobRecord {
  const id = makeJobId("subagent");
  const logPath = makeLogPath(id);
  const record: JobRecord = {
    id,
    kind: "subagent",
    label,
    status: "running",
    startedAt: Date.now(),
    logPath,
    abort,
  };
  ensureLogFile(record);
  registry.set(id, record);
  return record;
}

export function appendSubagentLog(id: string, line: string): void {
  const record = registry.get(id);
  if (!record) return;
  const stamped = line.endsWith("\n") ? line : `${line}\n`;
  appendLog(record, stamped);
}

export function completeSubagentJob(
  id: string,
  result: string,
  status: "done" | "error" | "cancelled" = "done",
  errMsg?: string,
): void {
  const record = registry.get(id);
  if (!record) return;
  if (record.status !== "running") return;
  record.status = status;
  record.endedAt = Date.now();
  record.result = result;
  if (errMsg) record.error = errMsg;
  appendLog(
    record,
    `\n[${status}${errMsg ? `: ${errMsg}` : ""}]\n`,
  );
}

export function getJob(id: string): JobRecord | undefined {
  return registry.get(id);
}

export function summarize(record: JobRecord): JobSummary {
  const end = record.endedAt ?? Date.now();
  return {
    id: record.id,
    kind: record.kind,
    label: record.label,
    status: record.status,
    runtimeMs: end - record.startedAt,
    exitCode: record.exitCode,
  };
}

export function listJobs(): JobSummary[] {
  return Array.from(registry.values())
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(summarize);
}

export function countRunning(): number {
  let n = 0;
  for (const rec of registry.values()) {
    if (rec.status === "running") n++;
  }
  return n;
}

export function readJobLog(id: string, tail?: number): string {
  const record = registry.get(id);
  if (!record) {
    return `Error: unknown job id '${id}'`;
  }
  let content = "";
  try {
    content = fs.readFileSync(record.logPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error reading log for ${id}: ${msg}`;
  }
  const lines = content.split("\n");
  const n = Math.min(
    Math.max(1, tail ?? JOB_LOG_TAIL_LINES_DEFAULT),
    JOB_LOG_TAIL_LINES_MAX,
  );
  const tailLines = lines.slice(-n);
  const omitted = lines.length - tailLines.length;
  const header = `[job ${id} | ${record.kind} | ${record.status}${omitted > 0 ? ` | showing last ${tailLines.length} of ${lines.length} lines` : ""
    }]\n`;
  return header + tailLines.join("\n");
}

export function killJob(id: string): string {
  const record = registry.get(id);
  if (!record) return `Error: unknown job id '${id}'`;
  if (record.status !== "running") {
    return `Job ${id} is not running (status=${record.status})`;
  }

  if (record.kind === "shell" && record.child) {
    killProcessGroup(record.child, "SIGTERM");
    setTimeout(() => {
      if (record.status === "running" && record.child) {
        killProcessGroup(record.child, "SIGKILL");
      }
    }, 2000);
    return `Sent SIGTERM to job ${id}`;
  }

  if (record.kind === "subagent" && record.abort) {
    record.abort.abort();
    return `Aborted subagent job ${id}`;
  }

  return `Job ${id} has no handle to kill`;
}

export function killAll(): void {
  for (const record of registry.values()) {
    if (record.status !== "running") continue;
    if (record.kind === "shell" && record.child) {
      killProcessGroup(record.child, "SIGTERM");
    } else if (record.kind === "subagent" && record.abort) {
      record.abort.abort();
    }
  }
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    let anyAlive = false;
    for (const record of registry.values()) {
      if (record.status === "running" && record.kind === "shell") {
        anyAlive = true;
        break;
      }
    }
    if (!anyAlive) break;
    const end = Date.now() + 50;
    while (Date.now() < end) {
      // busy wait briefly
    }
  }
  for (const record of registry.values()) {
    if (record.status === "running" && record.kind === "shell" && record.child) {
      killProcessGroup(record.child, "SIGKILL");
    }
  }
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
